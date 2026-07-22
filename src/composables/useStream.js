import { reactive, readonly } from "vue"
import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { useWorld } from "./useWorld.js"
import { usePacks } from "./usePacks.js"
import { loadLibrary } from "../lib.js"
import { chunkBlocks, dropEnclosed } from "../world.js"

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

const state = reactive({ on: false, tiles: 0, pending: 0 })

let root = null
let lib = null
let assets = null
let sharedAtlas = null
let world = null
let origin = null            // [blockX, blockY, blockZ] of the spawn chunk corner
let yRange = null
let dimension = "overworld"
let daytime = 6000
let lightOff = false
let chunkMap = null           // "cx,cz" -> chunk descriptor
let tileSet = null            // "tx,tz" tile keys with at least one chunk
let workers = []              // { worker, ready, inflight }
let workerSeq = 0
let anyWorkerReady = null     // resolves when the first worker finishes its zip scan
let spawned = false
const workerJobs = new Map()
let buildWorkers = []         // { worker, ready, inflight, mirror } tile build workers
let buildSeq = 0
const buildJobs = new Map()
const blockCache = new Map()  // "cx,cz" -> Promise<blocks in world coords>
const tiles = new Map()       // "cx,cz" -> { handle, group, cells, softs, boxes }
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
  update() {
    let v = sharedAtlas?.serial ?? 0
    for (const b of buildWorkers) v += b.mirror?.regionsVersion ?? 0
    if (v !== this.version) {
      this.version = v
      const texs = []
      for (const b of buildWorkers) b.mirror?.eachPage(pg => { if (pg.texture.userData.regions?.length) texs.push(pg.texture) })
      if (sharedAtlas) for (const sheet of sharedAtlas.sheets.values()) {
        for (const pg of sheet.pages) if (pg.texture.userData.regions?.length && !texs.includes(pg.texture)) texs.push(pg.texture)
      }
      this.schedules = texs.length && lib.buildSchedules ? lib.buildSchedules(texs) : []
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

// a small pool of parse workers; each owns its own zip scan, so parsing goes
// wide once they land. Before that (and if a worker fails) the main thread
// parses so the first tile never waits on the scans
function startWorkers(file, dimension) {
  const count = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 4) - 2))
  workers = []
  let readyResolve = null
  anyWorkerReady = new Promise(r => { readyResolve = r })
  for (let i = 0; i < count; i++) {
    let w
    try {
      w = new Worker(new URL("../streamWorker.js", import.meta.url), { type: "module" })
    } catch { break }
    const slot = { worker: w, ready: false, inflight: 0 }
    w.onmessage = e => {
      const m = e.data
      if (m.type === "ready") { slot.ready = true; readyResolve?.(); return }
      const job = workerJobs.get(m.id)
      if (!job) return
      workerJobs.delete(m.id)
      slot.inflight--
      if (m.type === "chunk") job.resolve(m.blocks)
      else job.reject(new Error(m.error))
    }
    w.onerror = () => { slot.ready = false }
    w.postMessage({ type: "init", id: 0, file, dimension, yMin: yRange.yMin, yMax: yRange.yMax })
    workers.push(slot)
  }
}

function stopWorkers() {
  for (const s of workers) s.worker.terminate()
  workers = []
  workerJobs.clear()
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

function idleWorker() {
  let best = null
  for (const s of workers) {
    if (!s.ready) continue
    if (!best || s.inflight < best.inflight) best = s
  }
  return best
}

function workerChunk(slot, cx, cz) {
  return new Promise((resolve, reject) => {
    const id = ++workerSeq
    workerJobs.set(id, { resolve, reject })
    slot.inflight++
    slot.worker.postMessage({ type: "chunk", id, cx, cz })
  })
}

function cachedBlocks(cx, cz) {
  const k = ckey(cx, cz)
  let p = blockCache.get(k)
  if (!p) {
    const c = chunkMap.get(k)
    const slot = c && idleWorker()
    if (!c) p = Promise.resolve([])
    else if (slot) p = workerChunk(slot, cx, cz).catch(() => chunkBlocks(world, c, yRange)).catch(() => [])
    else if (spawned && workers.length) {
      p = Promise.race([anyWorkerReady, new Promise(r => setTimeout(r, 15000))])
        .then(() => {
          const s = idleWorker()
          return s ? workerChunk(s, cx, cz) : chunkBlocks(world, c, yRange)
        })
        .catch(() => chunkBlocks(world, c, yRange)).catch(() => [])
    }
    else p = chunkBlocks(world, c, yRange).catch(() => [])
    blockCache.set(k, p)
    if (blockCache.size > 32) blockCache.delete(blockCache.keys().next().value)
  }
  return p
}

const solidByKey = new Map()
async function solidFlags(blocks) {
  const flags = new Uint8Array(blocks.length)
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const key = b.properties ?? b.id
    let v = solidByKey.get(key)
    if (v === undefined) {
      v = await lib.fullyOccludes?.({ id: b.id, properties: b.properties, assets }).catch(() => false) ?? false
      solidByKey.set(key, v)
    }
    flags[i] = v ? 1 : 0
  }
  return flags
}

const isPlane = el => el?.from && (el.from[0] === el.to[0] || el.from[1] === el.to[1] || el.from[2] === el.to[2])
const softCache = new Map()   // state key -> Promise<bool>
function softFor(entry) {
  const k = entry.id + "|" + JSON.stringify(entry.properties ?? null)
  let p = softCache.get(k)
  if (!p) {
    p = (async () => {
      let any = false, allPlanes = true
      for (const model of entry.models ?? []) {
        if (model?.fluid) continue
        const data = await lib.resolveModelData(assets, model)
        for (const el of data?.elements ?? []) { any = true; if (!isPlane(el)) allPlanes = false }
      }
      return any && allPlanes
    })().catch(() => false)
    softCache.set(k, p)
  }
  return p
}

const FLUID_BLOCK = /(^|:)(water|flowing_water|lava|flowing_lava|bubble_column)$/
const _cb = new THREE.Box3()
function templateBoxes(tmpl) {
  const arr = []
  const inFluid = o => {
    for (let n = o; n && n !== tmpl; n = n.parent) if (n.userData?.model?.fluid) return true
    return false
  }
  tmpl.updateMatrixWorld(true)
  tmpl.traverse(o => {
    const coll = o.userData.collision
    if (coll) {
      if (inFluid(o)) return
      for (const c of coll) {
        _cb.min.set(c[0], c[1], c[2])
        _cb.max.set(c[3], c[4], c[5])
        _cb.applyMatrix4(o.matrixWorld)
        if (!_cb.isEmpty()) arr.push([_cb.min.x, _cb.min.y, _cb.min.z, _cb.max.x, _cb.max.y, _cb.max.z])
      }
      return
    }
    if (!o.isMesh || o.parent?.userData.collision) return
    if (inFluid(o)) return
    _cb.setFromObject(o)
    if (!_cb.isEmpty()) arr.push([_cb.min.x, _cb.min.y, _cb.min.z, _cb.max.x, _cb.max.y, _cb.max.z])
  })
  return arr
}

async function buildTile(tx, tz, gen) {
  if (readyBuilders().length) return buildTileWorker(tx, tz, gen)
  return buildTileMain(tx, tz, gen)
}

async function buildTileWorker(tx, tz, gen) {
  const res = await workerTile(tx, tz)
  if (gen !== queueGen) return
  if (!res) return buildTileMain(tx, tz, gen)
  const { msg, slot } = res
  if (msg.empty) {
    tiles.set(ckey(tx, tz), { handle: null, group: null, cells: null, softs: null, boxes: null })
    return
  }
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
  try { await sceneApi2().renderer.compileAsync(revived.group, sceneApi2().perspCam, sceneApi2().scene) } catch {}
  if (gen !== queueGen) { revived.dispose(); return }
  root.add(revived.group)
  tiles.set(ckey(tx, tz), tile)
  state.tiles = tiles.size
  onTilesChanged?.()
}

async function buildTileMain(tx, tz, gen) {
  const x0 = tx * TILE, z0 = tz * TILE
  const ownFetches = [], ctxFetches = []
  for (let dx = -1; dx <= TILE; dx++) for (let dz = -1; dz <= TILE; dz++) {
    const own = dx >= 0 && dx < TILE && dz >= 0 && dz < TILE
    ;(own ? ownFetches : ctxFetches).push(cachedBlocks(x0 + dx, z0 + dz))
  }
  let input = []
  for (const own of await Promise.all(ownFetches)) {
    if (gen !== queueGen) return
    for (const b of own) {
      input.push({ ...b, pos: [b.pos[0] - origin[0], b.pos[1] - origin[1], b.pos[2] - origin[2]] })
    }
  }
  const rawOwn = input.length
  for (const nb of await Promise.all(ctxFetches)) {
    if (gen !== queueGen) return
    for (const b of nb) {
      input.push({ id: b.id, properties: b.properties, pos: [b.pos[0] - origin[0], b.pos[1] - origin[1], b.pos[2] - origin[2]], context: true })
    }
  }
  let extOcc = null
  if (rawOwn) {
    const de = dropEnclosed(input, await solidFlags(input))
    input = de.blocks
    extOcc = de.occludes
    if (gen !== queueGen) return
  }
  let tileCount = input.length
  for (let i = 0; i < input.length; i++) if (input[i].context) { tileCount = i; break }
  if (!tileCount) {
    tiles.set(ckey(tx, tz), { handle: null, group: null, cells: null, softs: null, boxes: null })
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
    externalOcclusion: extOcc,
    shouldCancel: () => gen !== queueGen
  })
  if (!handle || gen !== queueGen) {
    handle?.dispose?.()
    return
  }
  const cells = new Map()
  const softs = []
  for (let i = 0; i < tileCount; i++) {
    const ti = handle.blockTemplate[i]
    if (ti === 0xFFFFFFFF) continue
    const b = input[i]
    cells.set(b.pos.join(","), { pos: b.pos, ti, pi: handle.blockPalette[i], entry: b })
    if (softs[ti] === undefined) softs[ti] = softFor(handle.palette[handle.blockPalette[i]])
  }
  for (let i = 0; i < softs.length; i++) if (softs[i]) softs[i] = await softs[i]
  const tile = { handle, group: handle.group, cells, softs, boxes: new Map(), buriedFn: extOcc }
  try { await sceneApi2().renderer.compileAsync(handle.group, sceneApi2().perspCam, sceneApi2().scene) } catch {}
  if (gen !== queueGen) { try { handle.dispose?.() } catch {} return }
  root.add(handle.group)
  tiles.set(ckey(tx, tz), tile)
  state.tiles = tiles.size
  onTilesChanged?.()
}

function disposeTile(k) {
  const t = tiles.get(k)
  if (!t) return
  tiles.delete(k)
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
        for (let dx = 0; dx < TILE; dx++) for (let dz = 0; dz < TILE; dz++) cachedBlocks(ptx * TILE + dx, ptz * TILE + dz)
      }
      if (inflight.size) await Promise.race(Array.from(inflight.values()))
      await new Promise(r => setTimeout(r))
    }
  } finally {
    state.pending = 0
    building = false
  }
}

// worker tiles carry a flat grid over typed cell data; main-built tiles keep
// a cells Map. cellAt bridges both for the walk provider
function cellAt(t, gx, gy, gz) {
  if (!t) return null
  if (t.cells) {
    const c = t.cells.get(gx + "," + gy + "," + gz)
    if (c) return c
    if (t.buriedFn?.(gx, gy, gz)) return { pos: [gx, gy, gz], ti: -1, pi: -1, buried: true, entry: { id: "minecraft:stone" } }
    return null
  }
  if (!t.grid) return null
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
    const cell = cellAt(tiles.get(tkeyAt(gx, gz)), gx, gy, gz)
    if (!cell) return null
    const e = cell.entry
    return { Name: e.id, Properties: e.properties ?? undefined }
  },
  blockEntryAt(wx, wy, wz) {
    const gx = Math.round(wx / 16), gy = Math.round(wy / 16), gz = Math.round(wz / 16)
    const t = tiles.get(tkeyAt(gx, gz))
    const cell = cellAt(t, gx, gy, gz)
    return cell ? { tile: t, cell } : null
  },
  blockBoxes(b) {
    const { tile, cell } = b
    const out = []
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
  aimDoor: () => null,
  interact: () => null
}

// scene-space column -> highest solid block top, for the spawn point
async function surfaceAt(gx, gz) {
  const t = tiles.get(tkeyAt(gx, gz))
  if (!t) return null
  if (t.cells) {
    let top = null
    for (const cell of t.cells.values()) {
      if (cell.pos[0] !== gx || cell.pos[2] !== gz) continue
      if (FLUID_BLOCK.test(cell.entry.id) || t.softs[cell.ti]) continue
      if (top === null || cell.pos[1] > top) top = cell.pos[1]
    }
    return top
  }
  if (!t.grid) return null
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

async function enter() {
  const w = useWorld()
  world = w.getWorld()
  if (!world || state.on) return false
  lib = await loadLibrary()
  assets = packs2().assets.value
  if (!assets) return false
  sharedAtlas = lib.createSharedAtlas?.({ renderer: sceneApi2().renderer }) ?? null
  lib.setAnimationRenderer?.(sceneApi2().renderer)

  // the chunk under the orbit focus, mapped back through the selection layout
  chunkMap = new Map(w.getChunks().map(c => [ckey(c.cx, c.cz), c]))
  tileSet = new Set()
  for (const c of chunkMap.values()) tileSet.add(ckey(Math.floor(c.cx / TILE), Math.floor(c.cz / TILE)))
  const sel = w.getLastSelection()
  const target = sceneApi2().controls?.target ?? new THREE.Vector3()
  const rootPos = buildApi2().getRoot()?.position ?? { x: 0, y: 0, z: 0 }
  const lx = (target.x - rootPos.x) / 16, lz = (target.z - rootPos.z) / 16
  let wxb = lx, wzb = lz
  if (sel) {
    let best = null
    for (const p of sel.parts ?? [{ off: [0, 0, 0], world: [sel.worldOrigin[0], sel.worldOrigin[2]] }]) {
      const dx = Math.max(p.off[0] - lx, 0, p.size ? lx - (p.off[0] + p.size[0]) : 0)
      const dz = Math.max(p.off[2] - lz, 0, p.size ? lz - (p.off[2] + p.size[2]) : 0)
      const d = dx * dx + dz * dz
      if (!best || d < best.d) best = { d, p }
    }
    wxb = lx - best.p.off[0] + best.p.world[0]
    wzb = lz - best.p.off[2] + best.p.world[1]
  }
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
  queueGen++
  const wfile = w.getWorldFile()
  if (wfile) {
    startWorkers(wfile, ws.dimension)
    startBuildWorkers(wfile, ws.dimension)
  }
  root = new THREE.Group()
  sceneApi2().scene.add(root)
  sceneApi2().contentRoots.add(root)
  streamAnimator.version = -1
  sceneApi2().animators.add(streamAnimator)
  await buildApi2().build(EMPTY, false)
  sceneApi2().setGrids([])

  spawned = false
  playerTile = [Math.floor(scx / TILE), Math.floor(scz / TILE)]
  await buildTile(playerTile[0], playerTile[1], queueGen)
  spawned = true
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

async function exit() {
  if (!state.on) return
  state.on = false
  queueGen++
  playerTile = null
  stopWorkers()
  sceneApi2().animators.delete(streamAnimator)
  streamAnimator.schedules = []
  sharedAtlas?.dispose()
  sharedAtlas = null
  for (const k of Array.from(tiles.keys())) disposeTile(k)
  blockCache.clear()
  if (root) sceneApi2().contentRoots.delete(root)
  root?.removeFromParent()
  root = null
  const { useStructure } = await import("./useStructure.js")
  await useStructure().apply(true)
}

export function useStream() {
  return {
    state: readonly(state),
    provider,
    enter, exit, tick,
    setTilesChanged: fn => { onTilesChanged = fn }
  }
}
