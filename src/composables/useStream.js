import { reactive, readonly } from "vue"
import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { useWorld } from "./useWorld.js"
import { usePacks } from "./usePacks.js"
import { loadLibrary } from "../lib.js"
import { chunkGrid, mergeTilePalettes, assembleTile } from "../world.js"
import { attachTileDoors, importDoorTemplates, doorShape, rayBoxT, OPENABLE } from "./useStreamDoors.js"
import { softFor, solidFor, templateBoxes, DYNAMIC_BLOCKS } from "../streamShared.js"
import { attachTileDynamics } from "./useStreamDynamics.js"
import { isInspectable } from "../loot.js"

// world streaming: TILE x TILE chunks per tile, each tile its own createScene
// build bordered with a chunk ring of context blocks so culling, fluid shaping
// and the light volume come out seamless. Entered from walk mode; the orbit
// build is torn down on entry and rebuilt from the loaded selection on exit.
const TILE = 2
const RENDER_DIST = 3
const DISPOSE_DIST = RENDER_DIST + 1

// resolved lazily: instantiating these at module init closes an import cycle
let _scene = null, _build = null, _packs = null
const sceneApi2 = () => _scene ??= useScene()
const buildApi2 = () => _build ??= useBuild()
const packs2 = () => _packs ??= usePacks()

const state = reactive({ on: false, session: false, tiles: 0, pending: 0 })

let root = null
let lib = null
let assets = null
let sharedAtlas = null
let occlSeed = null
let world = null
let origin = null            // [blockX, blockY, blockZ] of the spawn chunk corner
let yRange = null
let dimension = "overworld"
let daytime = 6000
let lightOff = false
let chunkMap = null           // "cx,cz" -> chunk descriptor
let tileSet = null            // "tx,tz" tile keys with at least one chunk
let buildWorkers = []         // { worker, ready, inflight, mirror } tile build workers
let buildSeq = 0
const buildJobs = new Map()
const gridCache = new Map()   // "cx,cz" -> Promise<chunk grid> for main-thread builds
const tiles = new Map()       // "cx,cz" -> { handle, group, grid, softs, boxes }
let queueGen = 0
let building = false
let playerTile = null
let onTilesChanged = null

const EMPTY = { size: [1, 1, 1], palette: [], blocks: [], entities: [] }

// animates the mirror pages' atlas regions (water, lava, fire...) with the
// lib's schedule logic; applyFrame subimage-uploads via the registered renderer
const streamAnimator = {
  schedules: [],
  version: -1,
  lastTick: -1,
  perTex: new WeakMap(),
  update() {
    // animations run at game tick rates; evaluating at display refresh burns
    // main-thread time for identical frames, so cap evaluation at ~60Hz
    const tick = Math.floor(performance.now() / 16)
    if (tick === this.lastTick) return
    this.lastTick = tick
    let v = sharedAtlas?.serial ?? 0
    for (const b of buildWorkers) v += b.mirror?.regionsVersion ?? 0
    if (v !== this.version) {
      this.version = v
      const texs = []
      for (const b of buildWorkers) b.mirror?.eachPage(pg => { if (pg.texture.userData.regions?.length) texs.push(pg.texture) })
      if (sharedAtlas) for (const sheet of sharedAtlas.sheets.values()) {
        for (const pg of sheet.pages) if (pg.texture.userData.regions?.length && !texs.includes(pg.texture)) texs.push(pg.texture)
      }
      // rebuild per texture and keep schedule state for regions that persist,
      // else every region on every page re-applies in a single frame
      const all = []
      for (const tex of texs) {
        const regions = tex.userData.regions
        let c = this.perTex.get(tex)
        if (!c || c.count !== regions.length) {
          const fresh = lib.buildSchedules ? lib.buildSchedules([tex]) : []
          if (c) {
            const prev = new Map(c.schedules.map(s => [s.region, s]))
            for (const s of fresh) {
              const p = prev.get(s.region)
              if (p) s.lastKey = p.lastKey
            }
          }
          c = { count: regions.length, schedules: fresh }
          this.perTex.set(tex, c)
        }
        all.push(...c.schedules)
      }
      this.schedules = all
    }
    if (this.schedules.length) lib.evaluateAnimation(this.schedules, [], performance.now() / 50)
  }
}

const ckey = (cx, cz) => cx + "," + cz

function chunkOf(worldBlockX, worldBlockZ) {
  return [Math.floor(worldBlockX / 16), Math.floor(worldBlockZ / 16)]
}

// scene-space block coords -> owning tile key
function tkeyAt(gx, gz) {
  const cx = Math.floor((gx + origin[0]) / 16), cz = Math.floor((gz + origin[2]) / 16)
  return ckey(Math.floor(cx / TILE), Math.floor(cz / TILE))
}

function stopWorkers() {
  for (const b of buildWorkers) {
    b.worker.terminate()
    b.mirror?.dispose()
  }
  buildWorkers = []
  regionOwner.clear()
  for (const job of buildJobs.values()) job.resolve(null)
  buildJobs.clear()
}

function startBuildWorkers(file, dim, count = Math.min(3, Math.max(1, Math.floor(((navigator.hardwareConcurrency || 8) - 2) / 2)))) {
  if (new URLSearchParams(location.search).has("mainbuild")) return
  for (let i = 0; i < count; i++) {
    let w
    try {
      w = new Worker(new URL("../streamWorker.js", import.meta.url), { type: "module" })
    } catch { break }
    const slot = { worker: w, ready: false, inflight: 0, mirror: lib.createAtlasMirror?.({ renderer: sceneApi2().renderer }) ?? null }
    w.onmessage = e => {
      const m = e.data
      if (m.type === "ready") {
        w.postMessage({
          type: "initBuild", id: 0,
          sources: packs2().allSources(),
          occl: occlSeed,
          cfg: { origin, tile: TILE, dimension, daytime, lightOff }
        })
        return
      }
      if (m.type === "buildReady") { slot.ready = true; return }
      const job = buildJobs.get(m.id)
      if (!job) return
      buildJobs.delete(m.id)
      slot.inflight--
      job.resolve(m.type === "tile" ? { msg: m, slot } : null)
    }
    w.onerror = () => { slot.ready = false }
    w.postMessage({ type: "init", id: 0, file, dimension: dim, yMin: yRange.yMin, yMax: yRange.yMax })
    buildWorkers.push(slot)
  }
}

function readyBuilders() {
  return buildWorkers.filter(b => b.ready)
}

// tiles stick to one worker per region file, so each worker only inflates
// the regions it owns; overload spills to the least busy worker
const regionOwner = new Map()
function workerTile(tx, tz) {
  const rk = Math.floor(tx * TILE / 32) + "," + Math.floor(tz * TILE / 32)
  let best = regionOwner.get(rk)
  if (!best?.ready || best.inflight >= 4) {
    best = null
    for (const b of buildWorkers) {
      if (!b.ready) continue
      if (!best || b.inflight < best.inflight) best = b
    }
    if (best) regionOwner.set(rk, best)
  }
  if (!best) return Promise.resolve(null)
  return new Promise(resolve => {
    const id = ++buildSeq
    buildJobs.set(id, { resolve })
    best.inflight++
    best.worker.postMessage({ type: "build", id, tx, tz })
  })
}

function cachedGrid(cx, cz) {
  const k = ckey(cx, cz)
  let p = gridCache.get(k)
  if (!p) {
    const c = chunkMap.get(k)
    p = c ? chunkGrid(world, c, yRange).catch(() => null) : Promise.resolve(null)
    gridCache.set(k, p)
    if (gridCache.size > 48) gridCache.delete(gridCache.keys().next().value)
  } else {
    gridCache.delete(k)
    gridCache.set(k, p)
  }
  return p
}

const FLUID_BLOCK = /(^|:)(water|flowing_water|lava|flowing_lava|bubble_column)$/

async function buildTile(tx, tz, gen) {
  if (readyBuilders().length) return buildTileWorker(tx, tz, gen)
  return buildTileMain(tx, tz, gen)
}

// workers can finish several tiles in the same tick; reviving and uploading
// them all in one frame causes visible hitches, so integrations are spaced
// out to one per frame
const integrateQueue = []
let integrateArmed = false
function pumpIntegrate() {
  if (integrateArmed || !integrateQueue.length) return
  integrateArmed = true
  const fire = () => {
    integrateArmed = false
    integrateQueue.shift()?.()
    pumpIntegrate()
  }
  if (typeof document !== "undefined" && document.hidden) setTimeout(fire, 30)
  else requestAnimationFrame(fire)
}
const integrateSlot = () => new Promise(res => { integrateQueue.push(res); pumpIntegrate() })

async function buildTileWorker(tx, tz, gen) {
  const res = await workerTile(tx, tz)
  if (gen !== queueGen) return
  if (!res) return buildTileMain(tx, tz, gen)
  const { msg, slot } = res
  if (msg.empty) {
    tiles.set(ckey(tx, tz), { handle: null, group: null, cells: null, softs: null, boxes: null })
    return
  }
  await integrateSlot()
  if (gen !== queueGen) return
  slot.mirror.apply(msg.atlas)
  const revived = lib.reviveScene(msg.payload, { atlas: slot.mirror, releaseArrays: true })
  const ox = tx * TILE * 16 - origin[0], oz = tz * TILE * 16 - origin[2]
  const oy = yRange.yMin, gh = yRange.yMax - yRange.yMin + 1
  const gw = TILE * 16
  const grid = new Int32Array(gw * gw * gh)
  const cd = msg.cells
  for (let i = 0; i < cd.length; i += 5) {
    const lx = cd[i] - ox, ly = cd[i + 1] - oy, lz = cd[i + 2] - oz
    if (lx < 0 || lz < 0 || ly < 0 || lx >= gw || lz >= gw || ly >= gh) continue
    grid[(ly * gw + lz) * gw + lx] = (i / 5) + 1
  }
  const boxes = new Map(Object.entries(msg.boxes).map(([ti, arr]) => [Number(ti), arr]))
  const tile = { handle: revived, group: revived.group, cellData: cd, grid, ox, oy, oz, gw, gh, palette: msg.palette, softs: msg.softs, boxes, buried: msg.buried ?? null }
  if (msg.nbts?.length) tile.nbtMap = new Map(msg.nbts.map(n => [n.pos.join(","), n.nbt]))
  let lightMat = null, baseMat = null
  if (msg.doors?.length || msg.dynamics?.length) {
    revived.group.traverse(o => {
      if (!o.isMesh) return
      for (const m of [].concat(o.material)) {
        if (!lightMat && m?.uniforms?.lightVol) lightMat = m
        if (!baseMat && m?.uniforms?.worldShade) baseMat = m
      }
    })
  }
  if (msg.doors?.length) {
    if (msg.doorPack) importDoorTemplates(msg.doorPack, lightMat ?? baseMat)
    tile.doors = await attachTileDoors({ lib, assets, doors: msg.doors, group: revived.group, lightMat, onToggle: () => onTilesChanged?.() })
  }
  if (msg.dynamics?.length) {
    tile.dyn = await attachTileDynamics({ lib, assets, blocks: msg.dynamics, lightMat, sharedAtlas, dimension, daytime, lightOff })
    if (gen !== queueGen) { tile.dyn?.dispose(); revived.dispose(); return }
    if (tile.dyn) {
      root.add(tile.dyn.group)
      if (tile.dyn.animator) sceneApi2().animators.add(tile.dyn.animator)
    }
  }
  try { await sceneApi2().renderer.compileAsync(revived.group, sceneApi2().perspCam, sceneApi2().scene) } catch {}
  if (gen !== queueGen) { revived.dispose(); return }
  root.add(revived.group)
  // tiles never move, so drop their subtree from three's per-frame matrix walk
  revived.group.updateWorldMatrix(true, true)
  revived.group.matrixWorldAutoUpdate = false
  revealProgressively(revived.group)
  tiles.set(ckey(tx, tz), tile)
  state.tiles = tiles.size
  onTilesChanged?.()
}

// a tile's buffers upload on the frame each mesh first draws; revealing a
// couple of meshes per frame spreads that upload cost instead of spiking one
function revealProgressively(group) {
  const meshes = []
  group.traverse(o => { if (o.isMesh) { meshes.push(o); o.visible = false } })
  const reveal = () => {
    let budget = 2
    while (budget-- > 0 && meshes.length) meshes.shift().visible = true
    if (meshes.length) requestAnimationFrame(reveal)
  }
  requestAnimationFrame(reveal)
}

async function buildTileMain(tx, tz, gen) {
  const x0 = tx * TILE, z0 = tz * TILE
  const fetches = []
  for (let dz = -1; dz <= TILE; dz++) for (let dx = -1; dx <= TILE; dx++) fetches.push(cachedGrid(x0 + dx, z0 + dz))
  const chunkGrids = (await Promise.all(fetches)).filter(cg => cg && !cg.empty)
  if (gen !== queueGen) return
  const anyOwn = chunkGrids.some(cg => cg.cx >= x0 && cg.cx < x0 + TILE && cg.cz >= z0 && cg.cz < z0 + TILE)
  if (!anyOwn) {
    tiles.set(ckey(tx, tz), { handle: null, group: null, grid: null, softs: null, boxes: null })
    return
  }
  const { globalPalette, maps } = mergeTilePalettes(chunkGrids)
  const solidArr = new Uint8Array(globalPalette.length + 1)
  const doorArr = new Uint8Array(globalPalette.length + 1)
  const dynArr = new Uint8Array(globalPalette.length + 1)
  for (let i = 0; i < globalPalette.length; i++) {
    const e = globalPalette[i]
    doorArr[i + 1] = e.properties && "open" in e.properties && OPENABLE.test(e.id) ? 1 : 0
    dynArr[i + 1] = DYNAMIC_BLOCKS.test(e.id) ? 1 : 0
    solidArr[i + 1] = (await solidFor(lib, assets, e.id, e.properties)) ? 1 : 0
  }
  if (gen !== queueGen) return
  const at = assembleTile({
    chunkGrids, maps, globalPalette, solidArr, doorArr, dynArr, gcx0: x0 - 1, gcz0: z0 - 1,
    chunksAcross: TILE + 2, yMin: yRange.yMin, yMax: yRange.yMax, origin,
    ownTest: (lx, lz) => lx >= 16 && lz >= 16 && lx < (TILE + 1) * 16 && lz < (TILE + 1) * 16
  })
  const input = at.input, tileCount = at.tileCount, doors = at.doors
  if (!tileCount) {
    tiles.set(ckey(tx, tz), { handle: null, group: null, grid: null, softs: null, boxes: null })
    return
  }
  const handle = await lib.createScene(assets, input, {
    lighting: lightOff ? { dimension, daytime, light: false } : { dimension, daytime },
    keepTemplates: true,
    ignoreAtlases: true,
    technical: false,
    animate: false,
    sliceMs: 8,
    sharedAtlas,
    externalOcclusion: at.occludes,
    shouldCancel: () => gen !== queueGen
  })
  if (!handle || gen !== queueGen) {
    handle?.dispose?.()
    return
  }
  const gw = TILE * 16, gh = at.H, W = at.W
  const ox = x0 * 16 - origin[0], oy = yRange.yMin, oz = z0 * 16 - origin[2]
  const cellData = new Int32Array(tileCount * 5)
  let cn = 0
  const softs = {}
  for (let i = 0; i < tileCount; i++) {
    const ti = handle.blockTemplate[i]
    if (ti === 0xFFFFFFFF) continue
    const b = input[i]
    const pi = handle.blockPalette[i]
    cellData[cn++] = b.pos[0]
    cellData[cn++] = b.pos[1]
    cellData[cn++] = b.pos[2]
    cellData[cn++] = ti
    cellData[cn++] = pi
    if (softs[ti] === undefined) softs[ti] = softFor(lib, assets, handle.palette[pi])
  }
  for (const ti of Object.keys(softs)) softs[ti] = await softs[ti]
  const cd = cellData.slice(0, cn)
  const grid = new Int32Array(gw * gw * gh)
  for (let i = 0; i < cd.length; i += 5) {
    const lx = cd[i] - ox, ly = cd[i + 1] - oy, lz = cd[i + 2] - oz
    if (lx < 0 || lz < 0 || ly < 0 || lx >= gw || lz >= gw || ly >= gh) continue
    grid[(ly * gw + lz) * gw + lx] = (i / 5) + 1
  }
  const buried = new Uint8Array(Math.ceil(gw * gw * gh / 8))
  for (let ly = 0; ly < gh; ly++) for (let lz = 0; lz < gw; lz++) for (let lx = 0; lx < gw; lx++) {
    if (solidArr[at.tile[(ly * W + lz + 16) * W + lx + 16]]) {
      const bi = (ly * gw + lz) * gw + lx
      buried[bi >> 3] |= 1 << (bi & 7)
    }
  }
  const palette = handle.palette.map(p => ({ id: p.id, properties: p.properties ?? null }))
  const tile = { handle, group: handle.group, cellData: cd, grid, ox, oy, oz, gw, gh, palette, softs, boxes: new Map(), buried }
  if (at.nbts.length) tile.nbtMap = new Map(at.nbts.map(n => [n.pos.join(","), n.nbt]))
  let lightMat = null
  if (doors.length || at.dynamics.length) {
    handle.group.traverse(o => {
      if (lightMat || !o.isMesh) return
      for (const m of [].concat(o.material)) if (m?.uniforms?.lightVol) { lightMat = m; break }
    })
  }
  if (doors.length) {
    tile.doors = await attachTileDoors({ lib, assets, doors, group: handle.group, lightMat, onToggle: () => onTilesChanged?.() })
  }
  if (at.dynamics.length) {
    tile.dyn = await attachTileDynamics({ lib, assets, blocks: at.dynamics, lightMat, sharedAtlas, dimension, daytime, lightOff })
    if (gen !== queueGen) { tile.dyn?.dispose(); try { handle.dispose?.() } catch {} return }
    if (tile.dyn) {
      root.add(tile.dyn.group)
      if (tile.dyn.animator) sceneApi2().animators.add(tile.dyn.animator)
    }
  }
  try { await sceneApi2().renderer.compileAsync(handle.group, sceneApi2().perspCam, sceneApi2().scene) } catch {}
  if (gen !== queueGen) { try { handle.dispose?.() } catch {} return }
  root.add(handle.group)
  handle.group.updateWorldMatrix(true, true)
  handle.group.matrixWorldAutoUpdate = false
  tiles.set(ckey(tx, tz), tile)
  state.tiles = tiles.size
  onTilesChanged?.()
}

function disposeTile(k) {
  const t = tiles.get(k)
  if (!t) return
  tiles.delete(k)
  t.doors?.dispose()
  if (t.dyn) {
    if (t.dyn.animator) sceneApi2().animators.delete(t.dyn.animator)
    t.dyn.dispose()
  }
  if (t.handle) {
    t.group?.removeFromParent()
    try { t.handle.dispose?.() } catch {}
  }
  state.tiles = tiles.size
  onTilesChanged?.()
}

// in-frustum tiles build first (nearest-first middle-out within each group);
// the rest wait until the visible set is done. Re-evaluated every pump loop,
// so turning re-prioritizes what loads next
const _frustum = new THREE.Frustum()
const _frustumM = new THREE.Matrix4()
const _tileBox = new THREE.Box3()
function desired(tx, tz) {
  const cam = sceneApi2().perspCam
  let fr = null
  if (cam) {
    cam.updateMatrixWorld(true)
    _frustum.setFromProjectionMatrix(_frustumM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse))
    fr = _frustum
  }
  const out = []
  for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) {
    for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++) {
      const k = ckey(tx + dx, tz + dz)
      if (!tileSet.has(k) || tiles.has(k)) continue
      let vis = 0
      if (fr) {
        const bx = ((tx + dx) * TILE * 16 - origin[0]) * 16
        const bz = ((tz + dz) * TILE * 16 - origin[2]) * 16
        _tileBox.min.set(bx, yRange.yMin * 16, bz)
        _tileBox.max.set(bx + TILE * 256, (yRange.yMax + 1) * 16, bz + TILE * 256)
        vis = fr.intersectsBox(_tileBox) ? 0 : 1
      }
      out.push([tx + dx, tz + dz, vis * 1000 + dx * dx + dz * dz])
    }
  }
  out.sort((a, b) => a[2] - b[2])
  return out
}

async function pump() {
  if (building || !state.on) return
  building = true
  const gen = queueGen
  const inflight = new Map()
  try {
    while (state.on && gen === queueGen) {
      if (!playerTile) break
      for (const k of Array.from(tiles.keys())) {
        const [ttx, ttz] = k.split(",").map(Number)
        if (Math.max(Math.abs(ttx - playerTile[0]), Math.abs(ttz - playerTile[1])) > DISPOSE_DIST) disposeTile(k)
      }
      if (!state.on) break
      const want = desired(playerTile[0], playerTile[1]).filter(([tx, tz]) => !inflight.has(ckey(tx, tz)))
      state.pending = want.length + inflight.size
      if (!want.length && !inflight.size) break
      const width = readyBuilders().length * 2 || 1
      while (want.length && inflight.size < width) {
        const [tx, tz] = want.shift()
        const k = ckey(tx, tz)
        inflight.set(k, buildTile(tx, tz, gen).catch(() => {}).finally(() => inflight.delete(k)))
      }
      if (!readyBuilders().length) for (const [ptx, ptz] of want.slice(0, 3)) {
        for (let dx = 0; dx < TILE; dx++) for (let dz = 0; dz < TILE; dz++) cachedGrid(ptx * TILE + dx, ptz * TILE + dz)
      }
      if (inflight.size) await Promise.race(Array.from(inflight.values()))
      await new Promise(r => setTimeout(r))
    }
  } finally {
    state.pending = 0
    building = false
  }
}

// every tile carries a flat grid over typed cell data; buried cells read as
// solid stone so walk collision holds inside the dropped interior
function cellAt(t, gx, gy, gz) {
  if (!t?.grid) return null
  const lx = gx - t.ox, ly = gy - t.oy, lz = gz - t.oz
  if (lx < 0 || lz < 0 || ly < 0 || lx >= t.gw || lz >= t.gw || ly >= t.gh) return null
  const idx = t.grid[(ly * t.gw + lz) * t.gw + lx]
  if (!idx) {
    if (t.buried) {
      const bi = (ly * t.gw + lz) * t.gw + lx
      if (t.buried[bi >> 3] & (1 << (bi & 7))) return { pos: [gx, gy, gz], ti: -1, pi: -1, buried: true, entry: { id: "minecraft:stone" } }
    }
    return null
  }
  const i = (idx - 1) * 5
  const cd = t.cellData
  const p = t.palette[cd[i + 4]]
  return { pos: [cd[i], cd[i + 1], cd[i + 2]], ti: cd[i + 3], pi: cd[i + 4], entry: { id: p.id, properties: p.properties ?? undefined } }
}

// walk-facing provider, the same surface useBuild offers the walk mode
const provider = {
  getRoot: () => root,
  blockAt(wx, wy, wz) {
    const gx = Math.round(wx / 16), gy = Math.round(wy / 16), gz = Math.round(wz / 16)
    const t = tiles.get(tkeyAt(gx, gz))
    const cell = cellAt(t, gx, gy, gz)
    if (cell) return { Name: cell.entry.id, Properties: cell.entry.properties ?? undefined }
    const key = gx + "," + gy + "," + gz
    const reg = t?.doors?.regs.get(key)
    if (reg) return { Name: reg.id, Properties: reg.props }
    const dyn = t?.dyn?.regs.get(key)
    return dyn ? { Name: dyn.id, Properties: dyn.properties } : null
  },
  blockEntryAt(wx, wy, wz) {
    const gx = Math.round(wx / 16), gy = Math.round(wy / 16), gz = Math.round(wz / 16)
    const t = tiles.get(tkeyAt(gx, gz))
    const cell = cellAt(t, gx, gy, gz)
    const key = gx + "," + gy + "," + gz
    if (cell) {
      const nb = t.nbtMap?.get(key)
      if (nb && !cell.entry.nbt) cell.entry.nbt = nb
      return { tile: t, cell }
    }
    const reg = t?.doors?.regs.get(key)
    if (reg) return { tile: t, cell: { pos: [gx, gy, gz], door: reg, entry: { id: reg.id, properties: reg.props } } }
    const dyn = t?.dyn?.regs.get(key)
    return dyn ? { tile: t, cell: { pos: [gx, gy, gz], dyn, entry: { id: dyn.id, properties: dyn.properties, nbt: dyn.nbt } } } : null
  },
  blockBoxes(b) {
    const { tile, cell } = b
    const out = []
    if (cell.dyn) {
      const ox = cell.pos[0] * 16, oy = cell.pos[1] * 16, oz = cell.pos[2] * 16
      for (const l of tile.dyn.boxesFor(cell.dyn)) {
        out.push({ nx: l[0] + ox, ny: l[1] + oy, nz: l[2] + oz, px: l[3] + ox, py: l[4] + oy, pz: l[5] + oz })
      }
      return out
    }
    if (cell.door) {
      if (/fence_gate$/.test(cell.door.id.replace(/^minecraft:/, "")) && cell.door.props.open === "true") return out
      const ox = cell.pos[0] * 16, oy = cell.pos[1] * 16, oz = cell.pos[2] * 16
      for (const l of tile.doors.boxesFor(cell.door)) {
        out.push({ nx: l[0] + ox, ny: l[1] + oy, nz: l[2] + oz, px: l[3] + ox, py: l[4] + oy, pz: l[5] + oz })
      }
      return out
    }
    if (cell.buried) {
      const ox = cell.pos[0] * 16, oy = cell.pos[1] * 16, oz = cell.pos[2] * 16
      out.push({ nx: ox, ny: oy, nz: oz, px: ox + 16, py: oy + 16, pz: oz + 16 })
      return out
    }
    if (FLUID_BLOCK.test(cell.entry.id) || tile.softs[cell.ti]) return out
    let boxes = tile.boxes.get(cell.ti)
    if (!boxes) {
      const tmpl = tile.handle.templates?.[cell.ti]
      boxes = tmpl?.group ? templateBoxes(tmpl.group) : []
      tile.boxes.set(cell.ti, boxes)
    }
    const ox = cell.pos[0] * 16, oy = cell.pos[1] * 16, oz = cell.pos[2] * 16
    for (const l of boxes) out.push({ nx: l[0] + ox, ny: l[1] + oy, nz: l[2] + oz, px: l[3] + ox, py: l[4] + oy, pz: l[5] + oz })
    return out
  },
  aimDoor(ox, oy, oz, dx, dy, dz) {
    const h = marchDoor(ox, oy, oz, dx, dy, dz)
    if (h) return new THREE.Box3(
      new THREE.Vector3(h.bx + h.shape[0], h.by + h.shape[1], h.bz + h.shape[2]),
      new THREE.Vector3(h.bx + h.shape[3], h.by + h.shape[4], h.bz + h.shape[5]))
    const c = marchContainer(ox, oy, oz, dx, dy, dz)
    if (!c) return null
    const s = containerShape(c.entry.id, c.entry.properties ?? {})
    const bx = c.gx * 16 - 8, by = c.gy * 16 - 8, bz = c.gz * 16 - 8
    return new THREE.Box3(
      new THREE.Vector3(bx + s[0], by + s[1], bz + s[2]),
      new THREE.Vector3(bx + s[3], by + s[4], bz + s[5]))
  },
  interact(ox, oy, oz, dx, dy, dz) {
    const h = marchDoor(ox, oy, oz, dx, dy, dz)
    if (h) return { toggled: h.tile.doors.toggle(h.reg) }
    const c = marchContainer(ox, oy, oz, dx, dy, dz)
    if (!c) return false
    return { pos: c.cell.pos, entry: { Name: c.entry.id, Properties: c.entry.properties }, nbt: c.entry.nbt }
  }
}

// vanilla interaction shapes for aimed containers, matching orbit's shapeFor
function containerShape(id, p) {
  const name = (id || "").replace(/^minecraft:/, "")
  if (/chest$/.test(name)) return [1, 0, 1, 15, 14, 15]
  if (/(^|_)shelf$/.test(name)) {
    const f = p.facing ?? "north"
    return f === "north" ? [0, 0, 11, 16, 16, 16]
      : f === "south" ? [0, 0, 0, 16, 16, 5]
      : f === "west" ? [11, 0, 0, 16, 16, 16]
      : [0, 0, 0, 5, 16, 16]
  }
  return [0, 0, 0, 16, 16, 16]
}

function marchContainer(ox, oy, oz, dx, dy, dz) {
  let last = ""
  for (let t = 0; t <= 80; t += 2) {
    const gx = Math.round((ox + dx * t) / 16), gy = Math.round((oy + dy * t) / 16), gz = Math.round((oz + dz * t) / 16)
    const key = gx + "," + gy + "," + gz
    if (key === last) continue
    last = key
    const e = provider.blockEntryAt(gx * 16, gy * 16, gz * 16)
    if (!e) continue
    const name = e.cell.entry.id
    const nbt = e.cell.entry.nbt
    if (isInspectable(name) || nbt?.LootTable || /(^|[:_])spawner$/.test(name)) {
      return { cell: e.cell, entry: e.cell.entry, gx, gy, gz }
    }
    if (e.cell.buried) return null
    if (!e.cell.door && !e.cell.dyn && !(FLUID_BLOCK.test(name) || e.tile.softs?.[e.cell.ti])) {
      for (const b of provider.blockBoxes(e)) {
        if (rayBoxT(ox, oy, oz, dx, dy, dz, b.nx, b.ny, b.nz, b.px, b.py, b.pz) != null) return null
      }
    }
  }
  return null
}

function marchDoor(ox, oy, oz, dx, dy, dz) {
  let last = ""
  for (let t = 0; t <= 80; t += 2) {
    const gx = Math.round((ox + dx * t) / 16), gy = Math.round((oy + dy * t) / 16), gz = Math.round((oz + dz * t) / 16)
    const key = gx + "," + gy + "," + gz
    if (key === last) continue
    last = key
    const tl = tiles.get(tkeyAt(gx, gz))
    const reg = tl?.doors?.regs.get(key)
    if (!reg) continue
    const s = doorShape(reg.id, reg.props)
    const bx = gx * 16 - 8, by = gy * 16 - 8, bz = gz * 16 - 8
    const th = rayBoxT(ox, oy, oz, dx, dy, dz, bx + s[0], by + s[1], bz + s[2], bx + s[3], by + s[4], bz + s[5])
    if (th != null && th <= 80) return { tile: tl, reg, shape: s, bx, by, bz }
  }
  return null
}

// scene-space column -> highest solid block top, for the spawn point
async function surfaceAt(gx, gz) {
  const t = tiles.get(tkeyAt(gx, gz))
  if (!t?.grid) return null
  const lx = gx - t.ox, lz = gz - t.oz
  if (lx < 0 || lz < 0 || lx >= t.gw || lz >= t.gw) return null
  for (let ly = t.gh - 1; ly >= 0; ly--) {
    const idx = t.grid[(ly * t.gw + lz) * t.gw + lx]
    if (!idx) continue
    const i = (idx - 1) * 5
    const ti = t.cellData[i + 3]
    if (FLUID_BLOCK.test(t.palette[t.cellData[i + 4]].id) || t.softs[ti]) continue
    return t.oy + ly
  }
  return null
}

async function enter(spawn) {
  if (state.session && !state.on) {
    if (resumeCam) {
      const c = sceneApi2().perspCam
      c.position.set(resumeCam.x, resumeCam.y, resumeCam.z)
      c.rotation.set(resumeCam.pitch, resumeCam.yaw, 0, "YXZ")
      c.updateMatrixWorld(true)
    }
    state.on = true
    pump()
    return true
  }
  const w = useWorld()
  world = w.getWorld()
  if (!world || state.on || !spawn) return false
  lib = await loadLibrary()
  assets = packs2().assets.value
  if (!assets) return false
  sharedAtlas = lib.createSharedAtlas?.({ renderer: sceneApi2().renderer }) ?? null
  lib.setAnimationRenderer?.(sceneApi2().renderer)

  chunkMap = new Map(w.getChunks().map(c => [ckey(c.cx, c.cz), c]))
  tileSet = new Set()
  for (const c of chunkMap.values()) tileSet.add(ckey(Math.floor(c.cx / TILE), Math.floor(c.cz / TILE)))
  // spawn at the given chunk (the map's centre focus)
  const wxb = spawn.cx * 16 + 8, wzb = spawn.cz * 16 + 8
  let [scx, scz] = chunkOf(wxb, wzb)
  if (!chunkMap.has(ckey(scx, scz))) {
    let best = null
    for (const c of chunkMap.values()) {
      const d = (c.cx - scx) ** 2 + (c.cz - scz) ** 2
      if (!best || d < best.d) best = { d, c }
    }
    if (!best) return false
    scx = best.c.cx; scz = best.c.cz
  }

  const ws = w.state
  yRange = { yMin: ws.yMin, yMax: ws.yMax }
  dimension = /^(the_nether|the_end)$/.test(ws.dimension) ? ws.dimension : "overworld"
  daytime = buildApi2().state.daytime
  lightOff = buildApi2().state.fullbright || buildApi2().state.lighting !== "world"
  origin = [scx * 16, 0, scz * 16]

  state.on = true
  state.session = true
  queueGen++
  occlSeed = await lib.exportOcclusionCache?.(assets).catch(() => null) ?? null
  const wfile = w.getWorldFile()
  if (wfile) startBuildWorkers(wfile, ws.dimension)
  root = new THREE.Group()
  sceneApi2().scene.add(root)
  sceneApi2().contentRoots.add(root)
  streamAnimator.version = -1
  sceneApi2().animators.add(streamAnimator)
  await buildApi2().build(EMPTY, false)
  sceneApi2().setGrids([])

  playerTile = [Math.floor(scx / TILE), Math.floor(scz / TILE)]
  await buildTile(playerTile[0], playerTile[1], queueGen)
  const sgx = Math.min(scx * 16 + 15, Math.max(scx * 16, Math.floor(wxb))) - origin[0]
  const sgz = Math.min(scz * 16 + 15, Math.max(scz * 16, Math.floor(wzb))) - origin[2]
  const top = await surfaceAt(sgx, sgz) ?? await surfaceAt(8, 8)
  const spawnY = top !== null ? top * 16 + 8 : (yRange.yMax - origin[1]) * 16
  const cam = sceneApi2().perspCam
  cam.position.set(sgx * 16 + 8, spawnY + 28, sgz * 16 + 8)
  cam.rotation.set(0, 0, 0)
  cam.updateMatrixWorld(true)
  pump()
  return true
}

function tick(pos) {
  if (!state.on) return
  const gx = Math.round(pos.x / 16), gz = Math.round(pos.z / 16)
  const [cx, cz] = chunkOf(gx + origin[0], gz + origin[2])
  const tx = Math.floor(cx / TILE), tz = Math.floor(cz / TILE)
  if (!playerTile || playerTile[0] !== tx || playerTile[1] !== tz) {
    playerTile = [tx, tz]
    pump()
  }
}

// leaving walk keeps the streamed tiles as the live scene: streaming pauses,
// the orbit camera takes over where the player stood, and re-entering walk
// resumes the same session from the remembered spot
let resumeCam = null
function exit(cam) {
  if (!state.on) return
  state.on = false
  resumeCam = cam ?? null
}

// full teardown: before a fresh stream entry or when a new orbit build
// replaces the scene
function shutdown() {
  state.on = false
  state.session = false
  queueGen++
  playerTile = null
  stopWorkers()
  sceneApi2().animators.delete(streamAnimator)
  streamAnimator.schedules = []
  streamAnimator.perTex = new WeakMap()
  sharedAtlas?.dispose()
  sharedAtlas = null
  for (const k of Array.from(tiles.keys())) disposeTile(k)
  gridCache.clear()
  if (root) sceneApi2().contentRoots.delete(root)
  root?.removeFromParent()
  root = null
  occlSeed = null
  resumeCam = null
}

export function useStream() {
  return {
    state: readonly(state),
    provider,
    enter, exit, shutdown, tick,
    setTilesChanged: fn => { onTilesChanged = fn }
  }
}
