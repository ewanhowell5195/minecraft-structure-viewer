import { reactive, readonly } from "vue"
import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { useWorld } from "./useWorld.js"
import { usePacks } from "./usePacks.js"
import { loadLibrary } from "../lib.js"
import { chunkBlocks } from "../world.js"

// v1 world streaming: one chunk per tile, each tile its own createScene build
// bordered with full neighbor-chunk context blocks so culling, fluid shaping
// and the light volume come out seamless. Entered from walk mode; the orbit
// build is torn down on entry and rebuilt from the loaded selection on exit.
const RENDER_DIST = 4
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
let world = null
let origin = null            // [blockX, blockY, blockZ] of the spawn chunk corner
let yRange = null
let dimension = "overworld"
let daytime = 6000
let lightOff = false
let chunkMap = null           // "cx,cz" -> chunk descriptor
let worker = null
let workerReady = false
let workerSeq = 0
const workerJobs = new Map()
const blockCache = new Map()  // "cx,cz" -> Promise<blocks in world coords>
const tiles = new Map()       // "cx,cz" -> { handle, group, cells, softs, boxes }
let queueGen = 0
let building = false
let playerChunk = null
let onTilesChanged = null

const EMPTY = { size: [1, 1, 1], palette: [], blocks: [], entities: [] }

const ckey = (cx, cz) => cx + "," + cz

function chunkOf(worldBlockX, worldBlockZ) {
  return [Math.floor(worldBlockX / 16), Math.floor(worldBlockZ / 16)]
}

// the worker owns parsing once its own zip scan lands; before that (and if it
// ever fails) the main thread parses so the first tile never waits on the scan
function startWorker(file, dimension) {
  try {
    worker = new Worker(new URL("../streamWorker.js", import.meta.url), { type: "module" })
  } catch { worker = null; return }
  worker.onmessage = e => {
    const m = e.data
    if (m.type === "ready") { workerReady = true; return }
    const job = workerJobs.get(m.id)
    if (!job) return
    workerJobs.delete(m.id)
    if (m.type === "chunk") job.resolve(m.blocks)
    else job.reject(new Error(m.error))
  }
  worker.onerror = () => { workerReady = false }
  worker.postMessage({ type: "init", id: 0, file, dimension, yMin: yRange.yMin, yMax: yRange.yMax })
}

function stopWorker() {
  worker?.terminate()
  worker = null
  workerReady = false
  workerJobs.clear()
}

function workerChunk(cx, cz) {
  return new Promise((resolve, reject) => {
    const id = ++workerSeq
    workerJobs.set(id, { resolve, reject })
    worker.postMessage({ type: "chunk", id, cx, cz })
  })
}

function cachedBlocks(cx, cz) {
  const k = ckey(cx, cz)
  let p = blockCache.get(k)
  if (!p) {
    const c = chunkMap.get(k)
    if (!c) p = Promise.resolve([])
    else if (workerReady) p = workerChunk(cx, cz).catch(() => chunkBlocks(world, c, yRange)).catch(() => [])
    else p = chunkBlocks(world, c, yRange).catch(() => [])
    blockCache.set(k, p)
  }
  return p
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

async function buildTile(cx, cz, gen) {
  const own = await cachedBlocks(cx, cz)
  if (gen !== queueGen) return
  const input = []
  for (const b of own) {
    input.push({ ...b, pos: [b.pos[0] - origin[0], b.pos[1] - origin[1], b.pos[2] - origin[2]] })
  }
  const tileCount = input.length
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dz) continue
    const nb = await cachedBlocks(cx + dx, cz + dz)
    if (gen !== queueGen) return
    for (const b of nb) {
      input.push({ id: b.id, properties: b.properties, pos: [b.pos[0] - origin[0], b.pos[1] - origin[1], b.pos[2] - origin[2]], context: true })
    }
  }
  if (!tileCount) {
    tiles.set(ckey(cx, cz), { handle: null, group: null, cells: null, softs: null, boxes: null })
    return
  }
  const handle = await lib.createScene(assets, input, {
    lighting: lightOff ? { dimension, daytime, light: false } : { dimension, daytime },
    keepTemplates: true,
    ignoreAtlases: true,
    technical: false,
    animate: false,
    sliceMs: 8,
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
  const tile = { handle, group: handle.group, cells, softs, boxes: new Map() }
  root.add(handle.group)
  tiles.set(ckey(cx, cz), tile)
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

function desired(cx, cz) {
  const out = []
  for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) {
    for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++) {
      const k = ckey(cx + dx, cz + dz)
      if (chunkMap.has(k) && !tiles.has(k)) out.push([cx + dx, cz + dz, Math.max(Math.abs(dx), Math.abs(dz))])
    }
  }
  out.sort((a, b) => a[2] - b[2])
  return out
}

async function pump() {
  if (building || !state.on) return
  building = true
  const gen = queueGen
  try {
    while (state.on && gen === queueGen) {
      if (!playerChunk) break
      for (const k of Array.from(tiles.keys())) {
        const [tcx, tcz] = k.split(",").map(Number)
        if (Math.max(Math.abs(tcx - playerChunk[0]), Math.abs(tcz - playerChunk[1])) > DISPOSE_DIST) disposeTile(k)
      }
      const want = desired(playerChunk[0], playerChunk[1])
      state.pending = want.length
      if (!want.length) break
      await buildTile(want[0][0], want[0][1], gen)
      await new Promise(r => setTimeout(r))
    }
  } finally {
    state.pending = 0
    building = false
  }
}

// walk-facing provider, the same surface useBuild offers the walk mode
const provider = {
  getRoot: () => root,
  blockAt(wx, wy, wz) {
    const gx = Math.round(wx / 16), gy = Math.round(wy / 16), gz = Math.round(wz / 16)
    const [cx, cz] = chunkOf(gx + origin[0], gz + origin[2])
    const t = tiles.get(ckey(cx, cz))
    const cell = t?.cells?.get(gx + "," + gy + "," + gz)
    if (!cell) return null
    const e = cell.entry
    return { Name: e.id, Properties: e.properties ?? undefined }
  },
  blockEntryAt(wx, wy, wz) {
    const gx = Math.round(wx / 16), gy = Math.round(wy / 16), gz = Math.round(wz / 16)
    const [cx, cz] = chunkOf(gx + origin[0], gz + origin[2])
    const t = tiles.get(ckey(cx, cz))
    const cell = t?.cells?.get(gx + "," + gy + "," + gz)
    return cell ? { tile: t, cell } : null
  },
  blockBoxes(b) {
    const { tile, cell } = b
    const out = []
    if (FLUID_BLOCK.test(cell.entry.id) || tile.softs[cell.ti]) return out
    let boxes = tile.boxes.get(cell.ti)
    if (!boxes) {
      const tmpl = tile.handle.templates[cell.ti]
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
  const [cx, cz] = chunkOf(gx + origin[0], gz + origin[2])
  const t = tiles.get(ckey(cx, cz))
  if (!t?.cells) return null
  let top = null
  for (const cell of t.cells.values()) {
    if (cell.pos[0] !== gx || cell.pos[2] !== gz) continue
    if (FLUID_BLOCK.test(cell.entry.id) || t.softs[cell.ti]) continue
    if (top === null || cell.pos[1] > top) top = cell.pos[1]
  }
  return top
}

async function enter() {
  const w = useWorld()
  world = w.getWorld()
  if (!world || state.on) return false
  lib = await loadLibrary()
  assets = packs2().assets.value
  if (!assets) return false

  // the chunk under the orbit focus, mapped back through the selection layout
  chunkMap = new Map(w.getChunks().map(c => [ckey(c.cx, c.cz), c]))
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
  if (wfile) startWorker(wfile, ws.dimension)
  root = new THREE.Group()
  sceneApi2().scene.add(root)
  sceneApi2().contentRoots.add(root)
  await buildApi2().build(EMPTY, false)
  sceneApi2().setGrids([])

  playerChunk = [scx, scz]
  await buildTile(scx, scz, queueGen)
  const top = await surfaceAt((scx * 16 + 8) - origin[0], (scz * 16 + 8) - origin[2]) ?? await surfaceAt(8, 8)
  const spawnY = top !== null ? top * 16 + 8 : (yRange.yMax - origin[1]) * 16
  const cam = sceneApi2().perspCam
  cam.position.set(8 * 16, spawnY + 28, 8 * 16)
  cam.rotation.set(0, 0, 0)
  cam.updateMatrixWorld(true)
  pump()
  return true
}

function tick(pos) {
  if (!state.on) return
  const gx = Math.round(pos.x / 16), gz = Math.round(pos.z / 16)
  const [cx, cz] = chunkOf(gx + origin[0], gz + origin[2])
  if (!playerChunk || playerChunk[0] !== cx || playerChunk[1] !== cz) {
    playerChunk = [cx, cz]
    pump()
  }
}

async function exit() {
  if (!state.on) return
  state.on = false
  queueGen++
  playerChunk = null
  stopWorker()
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
