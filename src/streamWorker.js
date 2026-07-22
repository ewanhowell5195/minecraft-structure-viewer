// chunk parsing and whole tile builds for world streaming: zip inflate, NBT
// decode, createScene and geometry packing happen here so tile builds stop
// stealing main-thread frames. The build worker owns the shared atlas; the
// main thread mirrors its pages from the deltas each tile ships back.
import * as THREE from "three"
import { readWorldZip, switchDimension, chunkBlocks, chunkGrid, mergeTilePalettes, assembleTile } from "./world.js"
import { loadLibrary } from "./lib.js"
import { OPENABLE, packDoorTemplates } from "./composables/useStreamDoors.js"

let world = null
let range = null
let chunkMap = null
let lib = null
let assets = null
let sharedAtlas = null
let cfg = null
let atlasSerial = 0
const blockCache = new Map()
const shippedDoorStates = new Set()
const shippedDoorKeys = new Set()

const ckey = (cx, cz) => cx + "," + cz

function cachedGrid(cx, cz) {
  const k = ckey(cx, cz)
  let p = blockCache.get(k)
  if (!p) {
    const c = chunkMap.get(k)
    p = c ? chunkGrid(world, c, range).catch(() => null) : Promise.resolve(null)
    blockCache.set(k, p)
    if (blockCache.size > 48) blockCache.delete(blockCache.keys().next().value)
  } else {
    blockCache.delete(k)
    blockCache.set(k, p)
  }
  return p
}

const solidByKey = new Map()
async function entrySolid(e) {
  const key = e.id + "|" + (e.properties ? JSON.stringify(e.properties) : "")
  let v = solidByKey.get(key)
  if (v === undefined) {
    v = await lib.fullyOccludes({ id: e.id, properties: e.properties ?? undefined, assets }).catch(() => false)
    solidByKey.set(key, v)
  }
  return v
}

const isPlane = el => el?.from && (el.from[0] === el.to[0] || el.from[1] === el.to[1] || el.from[2] === el.to[2])
const softCache = new Map()
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

async function buildTile(m) {
  const TILE = cfg.tile, origin = cfg.origin
  const x0 = m.tx * TILE, z0 = m.tz * TILE
  const gcx0 = x0 - 1, gcz0 = z0 - 1
  const fetches = []
  for (let dz = -1; dz <= TILE; dz++) for (let dx = -1; dx <= TILE; dx++) fetches.push(cachedGrid(x0 + dx, z0 + dz))
  const chunkGrids = (await Promise.all(fetches)).filter(cg => cg && !cg.empty)
  const anyOwn = chunkGrids.some(cg => cg.cx >= x0 && cg.cx < x0 + TILE && cg.cz >= z0 && cg.cz < z0 + TILE)
  if (!anyOwn) { self.postMessage({ type: "tile", id: m.id, empty: true }); return }
  const { globalPalette, maps } = mergeTilePalettes(chunkGrids)
  const solidArr = new Uint8Array(globalPalette.length + 1)
  const doorArr = new Uint8Array(globalPalette.length + 1)
  for (let i = 0; i < globalPalette.length; i++) {
    const e = globalPalette[i]
    doorArr[i + 1] = e.properties && "open" in e.properties && OPENABLE.test(e.id) ? 1 : 0
    solidArr[i + 1] = (await entrySolid(e)) ? 1 : 0
  }
  const at = assembleTile({
    chunkGrids, maps, globalPalette, solidArr, doorArr, gcx0, gcz0,
    chunksAcross: TILE + 2, yMin: range.yMin, yMax: range.yMax, origin,
    ownTest: (lx, lz) => lx >= 16 && lz >= 16 && lx < (TILE + 1) * 16 && lz < (TILE + 1) * 16
  })
  const input = at.input
  const tileCount = at.tileCount
  const doors = at.doors
  if (!tileCount) { self.postMessage({ type: "tile", id: m.id, empty: true }); return }
  const handle = await lib.createScene(assets, input, {
    lighting: cfg.lightOff ? { dimension: cfg.dimension, daytime: cfg.daytime, light: false } : { dimension: cfg.dimension, daytime: cfg.daytime },
    keepTemplates: true,
    ignoreAtlases: true,
    technical: false,
    animate: false,
    sliceMs: 10000,
    batchDynamics: false,
    sharedAtlas,
    externalOcclusion: at.occludes
  })
  if (!handle) { self.postMessage({ type: "tile", id: m.id, empty: true }); return }
  const cellData = new Int32Array(tileCount * 5)
  let cn = 0
  const softs = {}
  const boxes = {}
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
    if (softs[ti] === undefined) {
      softs[ti] = softFor(handle.palette[pi])
      const tmpl = handle.templates?.[ti]
      boxes[ti] = tmpl?.group ? templateBoxes(tmpl.group) : []
    }
  }
  for (const ti of Object.keys(softs)) softs[ti] = await softs[ti]
  const cells = cellData.slice(0, cn)
  const palette = handle.palette.map(p => ({ id: p.id, properties: p.properties ?? null }))
  const gw = TILE * 16, gh = at.H, W = at.W
  const buried = new Uint8Array(Math.ceil(gw * gw * gh / 8))
  for (let ly = 0; ly < gh; ly++) for (let lz = 0; lz < gw; lz++) for (let lx = 0; lx < gw; lx++) {
    if (solidArr[at.tile[(ly * W + lz + 16) * W + lx + 16]]) {
      const bi = (ly * gw + lz) * gw + lx
      buried[bi >> 3] |= 1 << (bi & 7)
    }
  }
  const packed = await lib.packScene(handle, { sharedAtlas })
  const atlas = await lib.packAtlasDelta(sharedAtlas, atlasSerial)
  atlasSerial = atlas.serial
  try { handle.dispose?.() } catch {}
  let doorPack = null, doorTransfers = []
  if (doors.length) {
    try {
      const dp = await packDoorTemplates(lib, assets, doors, shippedDoorStates, shippedDoorKeys)
      if (dp) { doorPack = dp.pack; doorTransfers = dp.transfers }
    } catch {}
  }
  self.postMessage(
    { type: "tile", id: m.id, payload: packed.payload, atlas: { deltas: atlas.deltas, serial: atlas.serial, size: atlas.size }, cells, palette, softs, boxes, buried, doors, doorPack },
    [cells.buffer, ...(buried ? [buried.buffer] : []), ...packed.transfers, ...atlas.transfers, ...doorTransfers]
  )
}

self.onmessage = async e => {
  const m = e.data
  try {
    if (m.type === "init") {
      world = await readWorldZip(m.file)
      if (m.dimension && m.dimension !== world.dimension) world = await switchDimension(world, m.dimension)
      range = { yMin: m.yMin, yMax: m.yMax }
      chunkMap = new Map(world.chunks.map(c => [c.cx + "," + c.cz, c]))
      self.postMessage({ type: "ready", id: m.id })
    } else if (m.type === "initBuild") {
      lib = await loadLibrary()
      assets = await lib.prepareAssets(m.sources, { cache: true })
      if (m.occl) await lib.importOcclusionCache?.(assets, m.occl).catch(() => {})
      sharedAtlas = lib.createSharedAtlas()
      cfg = m.cfg
      self.postMessage({ type: "buildReady", id: m.id })
    } else if (m.type === "build") {
      await buildTile(m)
    } else if (m.type === "chunk") {
      const c = chunkMap.get(m.cx + "," + m.cz)
      const blocks = c ? await chunkBlocks(world, c, range) : []
      self.postMessage({ type: "chunk", id: m.id, blocks })
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, error: String(err?.message ?? err) })
  }
}
