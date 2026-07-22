// chunk parsing and whole tile builds for world streaming: zip inflate, NBT
// decode, createScene and geometry packing happen here so tile builds stop
// stealing main-thread frames. The build worker owns the shared atlas; the
// main thread mirrors its pages from the deltas each tile ships back.
import * as THREE from "three"
import { readWorldZip, switchDimension, chunkBlocks } from "./world.js"
import { loadLibrary } from "./lib.js"

let world = null
let range = null
let chunkMap = null
let lib = null
let assets = null
let sharedAtlas = null
let cfg = null
let atlasSerial = 0
const blockCache = new Map()

const ckey = (cx, cz) => cx + "," + cz

function cachedBlocks(cx, cz) {
  const k = ckey(cx, cz)
  let p = blockCache.get(k)
  if (!p) {
    const c = chunkMap.get(k)
    p = c ? chunkBlocks(world, c, range).catch(() => []) : Promise.resolve([])
    blockCache.set(k, p)
  }
  return p
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
  const ownF = [], ctxF = []
  for (let dx = -1; dx <= TILE; dx++) for (let dz = -1; dz <= TILE; dz++) {
    const own = dx >= 0 && dx < TILE && dz >= 0 && dz < TILE
    ;(own ? ownF : ctxF).push(cachedBlocks(x0 + dx, z0 + dz))
  }
  const input = []
  for (const own of await Promise.all(ownF)) {
    for (const b of own) input.push({ ...b, pos: [b.pos[0] - origin[0], b.pos[1] - origin[1], b.pos[2] - origin[2]] })
  }
  const tileCount = input.length
  for (const nb of await Promise.all(ctxF)) {
    for (const b of nb) input.push({ id: b.id, properties: b.properties, pos: [b.pos[0] - origin[0], b.pos[1] - origin[1], b.pos[2] - origin[2]], context: true })
  }
  if (!tileCount) { self.postMessage({ type: "tile", id: m.id, empty: true }); return }
  const handle = await lib.createScene(assets, input, {
    lighting: cfg.lightOff ? { dimension: cfg.dimension, daytime: cfg.daytime, light: false } : { dimension: cfg.dimension, daytime: cfg.daytime },
    keepTemplates: true,
    ignoreAtlases: true,
    technical: false,
    animate: false,
    sliceMs: 50,
    batchDynamics: false,
    sharedAtlas
  })
  if (!handle) { self.postMessage({ type: "tile", id: m.id, empty: true }); return }
  const cells = []
  const softs = {}
  const boxes = {}
  for (let i = 0; i < tileCount; i++) {
    const ti = handle.blockTemplate[i]
    if (ti === 0xFFFFFFFF) continue
    const b = input[i]
    cells.push({ pos: b.pos, ti, pi: handle.blockPalette[i], id: b.id, properties: b.properties ?? null })
    if (softs[ti] === undefined) {
      softs[ti] = softFor(handle.palette[handle.blockPalette[i]])
      const tmpl = handle.templates?.[ti]
      boxes[ti] = tmpl?.group ? templateBoxes(tmpl.group) : []
    }
  }
  for (const ti of Object.keys(softs)) softs[ti] = await softs[ti]
  const packed = await lib.packScene(handle, { sharedAtlas })
  const atlas = await lib.packAtlasDelta(sharedAtlas, atlasSerial)
  atlasSerial = atlas.serial
  try { handle.dispose?.() } catch {}
  self.postMessage(
    { type: "tile", id: m.id, payload: packed.payload, atlas: { deltas: atlas.deltas, serial: atlas.serial, size: atlas.size }, cells, softs, boxes },
    [...packed.transfers, ...atlas.transfers]
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
