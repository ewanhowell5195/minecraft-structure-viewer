import { reactive, readonly } from "vue"
import { readWorldZip, readRegionFile, buildSelection, unzipEntry, chunkSurface, chunkYExtent, readChunk, switchDimension } from "../world.js"
import { readNBT } from "../nbt.js"
import { useStructure } from "./useStructure.js"
import { useBuild } from "./useBuild.js"
import { useStructures } from "./useStructures.js"
import { cacheFile, uncache } from "../userCache.js"

let lastSelection = null
let worldFile = null
const state = reactive({
  active: false,
  name: "",
  chunkCount: 0,
  selCount: 0,
  error: "",
  busy: false,
  loading: null,
  memWarn: false,
  stopped: null,
  oldWorld: false,
  dimensions: [],
  dimension: "",
  structs: [],
  rangeWarn: false,
  regionFile: false,
  rev: 0,
  focusRev: 0,
  yMin: 48,
  yMax: 200
})

let world = null
const selected = new Set()

const surface = new Map()
let queue = [], qi = 0
let focusTimer = null
let lastFocus = ""
let pumping = false
let focus = null
let autoRange = false

function setScanFocus(x0, z0, x1, z1) {
  const key = x0 + "," + z0 + "," + x1 + "," + z1
  if (key === lastFocus) return
  lastFocus = key
  clearTimeout(focusTimer)
  focusTimer = setTimeout(() => {
    if (!world) return
    focus = { x0, z0, x1, z1 }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
    const rings = []
    for (const c of world.chunks) {
      if (c.cx < x0 || c.cx > x1 || c.cz < z0 || c.cz > z1) continue
      if (surface.has(c.cx + "," + c.cz)) continue
      const r = Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)) | 0
      ;(rings[r] ??= []).push(c)
    }
    queue = rings.flat()
    qi = 0
    pump()
  }, 300)
}

async function pump() {
  if (pumping) return
  pumping = true
  const w = world
  let t0 = performance.now(), lastRev = t0
  while (qi < queue.length && world === w) {
    const c = queue[qi++]
    const key = c.cx + "," + c.cz
    if (!surface.has(key)) {
      try { surface.set(key, await chunkSurface(w, c, state.yMin, state.yMax)) } catch {}
    }
    const now = performance.now()
    if (now - t0 > 12) {
      if (now - lastRev > 200) { state.rev++; lastRev = now }
      await new Promise(r => setTimeout(r))
      t0 = performance.now()
    }
  }
  pumping = false
  if (world === w) {
    state.rev++
    evalRange()
  }
}

const visibleChunks = () => !focus || !world ? []
  : world.chunks.filter(c => c.cx >= focus.x0 && c.cx <= focus.x1 && c.cz >= focus.z0 && c.cz <= focus.z1)

function evalRange() {
  const vis = visibleChunks()
  if (!vis.length) {
    state.rangeWarn = false
    return
  }
  for (const c of vis) {
    const s = surface.get(c.cx + "," + c.cz)
    if (s === undefined) return
    if (s !== null) {
      state.rangeWarn = false
      autoRange = false
      return
    }
  }
  if (autoRange) {
    autoRange = false
    applySuggestedRange()
  } else {
    state.rangeWarn = true
  }
}

async function applySuggestedRange() {
  const w = world
  if (!w) return
  let chunks = visibleChunks()
  if (!chunks.length) chunks = w.chunks
  const step = Math.max(1, Math.floor(chunks.length / 12))
  let top = -Infinity, bottom = Infinity
  for (let i = 0; i < chunks.length; i += step) {
    if (world !== w) return
    let r = null
    try { r = await chunkYExtent(w, chunks[i]) } catch {}
    if (!r) continue
    if (r.top > top) top = r.top
    if (r.bottom < bottom) bottom = r.bottom
  }
  if (top === -Infinity) return
  state.rangeWarn = false
  setYRange(Math.max(-64, Math.max(bottom, top - 40)), Math.min(320, top))
}

function fillGridWindow(d, w0x, w0z, size, tpc, hideSel = false) {
  d.fill(0)
  if (!world) return
  const span = size / tpc
  for (const c of world.chunks) {
    const key = c.cx + "," + c.cz
    const s = surface.get(key)
    if (s === null) continue
    const sel = !hideSel && selected.has(key) ? 128 : 0
    const bx = c.cx - w0x, bz = c.cz - w0z
    if (bx < 0 || bz < 0 || bx >= span || bz >= span) continue
    if (tpc === 1) {
      d[bz * size + bx] = (s ? s[64] : 1) | sel
      continue
    }
    const t0 = (bz * 8) * size + bx * 8
    for (let sz = 0; sz < 8; sz++) for (let sx = 0; sx < 8; sx++) {
      d[t0 + sz * size + sx] = (s ? s[sz * 8 + sx] : 1) | sel
    }
  }
}

async function openWorld(file, cacheIt = true) {
  state.error = ""
  state.busy = true
  state.active = true
  worldFile = file
  state.name = file.name.replace(/\.(zip|mca)$/i, "")
  state.loading = { done: 0, total: 0 }
  state.rangeWarn = false
  surface.clear()
  queue = []
  qi = 0
  lastFocus = ""
  focus = null
  autoRange = true
  try {
    state.regionFile = /\.mca$/i.test(file.name)
    world = state.regionFile
      ? readRegionFile(await file.arrayBuffer(), file.name)
      : await readWorldZip(file, (done, total) => { state.loading = { done, total } })
    selected.clear()
    state.name = world.name || file.name.replace(/\.(zip|mca)$/i, "")
    state.chunkCount = world.chunks.length
    state.selCount = 0
    state.dimensions = world.dims?.map(d => d.id) ?? []
    state.dimension = world.dimension ?? ""
    for (const c of world.chunks.slice(0, 8)) {
      try {
        const nbt = await readChunk(world, c)
        if (nbt.sections) break
        if (nbt.Level) {
          state.oldWorld = true
          break
        }
      } catch {}
    }
    useStructures().setWorldStructures([...world.structures.keys()])
    state.structs = world.structList ?? []
    if (cacheIt) cacheFile("world", file)
  } catch (err) {
    world = null
    useStructures().setWorldStructures([])
    state.name = file.name.replace(/\.(zip|mca)$/i, "")
    state.chunkCount = 0
    state.selCount = 0
    state.dimensions = []
    state.dimension = ""
    state.structs = []
    state.error = String(err.message ?? err)
  } finally {
    state.busy = false
    state.loading = null
    state.rev++
  }
}

async function applyDimension(id) {
  world = await switchDimension(world, id, (done, total) => { state.loading = { done, total } })
  state.dimension = id
  state.chunkCount = world.chunks.length
  selected.clear()
  state.selCount = 0
  surface.clear()
  queue = []
  qi = 0
  lastFocus = ""
  focus = null
  state.rangeWarn = false
  autoRange = true
}

async function setDimension(id) {
  if (!world || state.busy || id === state.dimension) return
  state.error = ""
  state.busy = true
  state.loading = { done: 0, total: 0 }
  try {
    await applyDimension(id)
    setWorldParams(false)
  } catch (err) {
    state.error = String(err.message ?? err)
  } finally {
    state.busy = false
    state.loading = null
    state.rev++
  }
}

function toggleChunk(key, on) {
  if (on ?? !selected.has(key)) selected.add(key)
  else selected.delete(key)
  state.selCount = selected.size
  state.rev++
}

function clearSelection() {
  selected.clear()
  state.selCount = 0
  state.rev++
}

function rectHasSelected(aCx, aCz, bCx, bCz) {
  const x0 = Math.min(aCx, bCx), x1 = Math.max(aCx, bCx)
  const z0 = Math.min(aCz, bCz), z1 = Math.max(aCz, bCz)
  for (const k of selected) {
    const [x, z] = k.split(",").map(Number)
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return true
  }
  return false
}

function selectRect(aCx, aCz, bCx, bCz) {
  if (!world) return
  const on = !rectHasSelected(aCx, aCz, bCx, bCz)
  const x0 = Math.min(aCx, bCx), x1 = Math.max(aCx, bCx)
  const z0 = Math.min(aCz, bCz), z1 = Math.max(aCz, bCz)
  for (const c of world.chunks) {
    if (c.cx < x0 || c.cx > x1 || c.cz < z0 || c.cz > z1) continue
    const key = c.cx + "," + c.cz
    if (on) selected.add(key)
    else selected.delete(key)
  }
  state.selCount = selected.size
  state.rev++
}

const isSelected = key => selected.has(key)

function selectionBounds() {
  if (!selected.size) return null
  let minCx = Infinity, maxCx = -Infinity, minCz = Infinity, maxCz = -Infinity
  for (const k of selected) {
    const [x, z] = k.split(",").map(Number)
    if (x < minCx) minCx = x
    if (x > maxCx) maxCx = x
    if (z < minCz) minCz = z
    if (z > maxCz) maxCz = z
  }
  return { minCx, maxCx, minCz, maxCz }
}

async function packSel() {
  const stream = new Blob([[...selected].join(";")]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

async function unpackSel(param) {
  try {
    const bin = atob(param.replaceAll("-", "+").replaceAll("_", "/"))
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    return (await new Response(stream).text()).split(";")
  } catch {
    return []
  }
}

async function setWorldParams(on) {
  const u = new URL(location)
  if (on) {
    u.searchParams.set("wy", state.yMin + "," + state.yMax)
    u.searchParams.set("wsel", await packSel())
    u.searchParams.set("wloaded", "1")
    if (state.dimension) u.searchParams.set("wdim", state.dimension)
    else u.searchParams.delete("wdim")
  } else {
    u.searchParams.delete("wy")
    u.searchParams.delete("wsel")
    u.searchParams.delete("wloaded")
    u.searchParams.delete("wdim")
  }
  history.replaceState(null, "", u)
}

async function restoreLoad(wy, wsel, wdim) {
  if (!world) return
  if (wdim && wdim !== state.dimension && world.dims?.some(d => d.id === wdim)) {
    try { await applyDimension(wdim) } catch { return } finally {
      state.loading = null
      state.rev++
    }
  }
  const [lo, hi] = (wy ?? "").split(",").map(Number)
  if (Number.isFinite(lo) && Number.isFinite(hi)) setYRange(lo, hi)
  selected.clear()
  for (const key of await unpackSel(wsel)) if (key) selected.add(key)
  state.selCount = selected.size
  state.rev++
  if (!selected.size) return
  state.focusRev++
  let probe
  try { probe = await buildSelection(world, selected, { yMin: state.yMin, yMax: state.yMax, cap: 24000 }) } catch (err) {
    if (err?.oldChunks) state.oldWorld = true
    return
  }
  const est = probe.capped
    ? Math.round(probe.blocks.length * probe.chunksTotal / probe.chunksLoaded / 1000) * 1000
    : probe.blocks.length
  if (!await useBuild().restoreGateCheck(est, true, probe.capped)) return
  await loadSelected()
}

let memResolve = null
function answerMemWarn(ok) {
  state.memWarn = false
  memResolve?.(ok)
  memResolve = null
}

async function loadSelected() {
  if (!world || !selected.size) return
  state.error = ""
  if (loadForecast()) {
    state.memWarn = true
    if (!await new Promise(r => { memResolve = r })) return
  }
  const ios = /iPhone|iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  state.busy = true
  const sApi = useStructure()
  sApi.setReading({ done: 0, total: 0, label: "reading chunks" })
  try {
    lastSelection = null
    const s = await buildSelection(world, selected, { yMin: state.yMin, yMax: state.yMax, budget: ios ? 0.6e9 : 1.6e9 },
      (done, total) => {
        sApi.setReading({ done, total, label: "reading chunks" })
        return !sApi.readCancelled()
      })
    sApi.setReading(null)
    s.dimension = state.dimension
    lastSelection = { worldOrigin: s.worldOrigin, parts: s.__parts ?? null }
    const n = s.truncated ? s.chunksLoaded : selected.size
    await sApi.loadObject(s, `${state.name} · ${n} chunk${n === 1 ? "" : "s"}`, true)
    if (s.truncated) state.stopped = { loaded: s.chunksLoaded, total: s.chunksTotal }
    setWorldParams(true)
  } catch (err) {
    if (err?.oldChunks) state.oldWorld = true
    else if (err?.message !== "cancelled") state.error = String(err.message ?? err)
  } finally {
    state.busy = false
    sApi.setReading(null)
  }
}

function closeWorld() {
  world = null
  surface.clear()
  queue = []
  qi = 0
  lastFocus = ""
  selected.clear()
  state.active = false
  state.selCount = 0
  state.error = ""
  state.stopped = null
  state.oldWorld = false
  state.dimensions = []
  state.dimension = ""
  state.structs = []
  state.rangeWarn = false
  useStructures().setWorldStructures([])
  uncache("world")
  setWorldParams(false)
}

const FORCE = typeof location !== "undefined" && new URLSearchParams(location.search).has("force")

function loadForecast() {
  if (FORCE || !selected.size) return false
  const est = selected.size * 256 * (state.yMax - state.yMin + 1) * 120
  const mem = performance.memory
  const ios = /iPhone|iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  const headroom = mem ? mem.jsHeapSizeLimit - mem.usedJSHeapSize : ios ? 0.6e9 : 1.6e9
  return est > headroom * 0.8
}

const hasStructure = rel => !!world?.structures.has(rel)
const readStructureBytes = rel => unzipEntry(world.structures.get(rel))

function mapEntry(id) {
  const root = world?.root ?? ""
  return world?.files?.get(root + "data/minecraft/maps/" + id + ".dat")
    ?? world?.files?.get(root + "data/map_" + id + ".dat")
}

const hasMap = id => !!mapEntry(id)

async function readMap(id) {
  const entry = mapEntry(id)
  if (!entry) return null
  try {
    const nbt = await readNBT(await unzipEntry(entry))
    const c = nbt.data?.colors
    if (!c || c.length < 16384) return null
    return Array.isArray(c) ? Uint8Array.from(c) : new Uint8Array(c.buffer, c.byteOffset, c.length)
  } catch {
    return null
  }
}

let rangeTimer = null
function setYRange(lo, hi) {
  const yMin = Math.min(lo, hi), yMax = Math.max(lo, hi)
  if (yMin === state.yMin && yMax === state.yMax) return
  state.yMin = yMin
  state.yMax = yMax
  state.rangeWarn = false
  // the surface preview clips to the y range, so a change rescans (debounced for slider drags)
  clearTimeout(rangeTimer)
  rangeTimer = setTimeout(() => {
    if (!world) return
    surface.clear()
    queue = []
    qi = 0
    lastFocus = ""
    state.rev++
  }, 300)
}

export function useWorld() {
  return {
    state: readonly(state), openWorld, toggleChunk, isSelected, clearSelection, selectRect, rectHasSelected, selectionBounds, loadSelected, closeWorld,
    hasStructure, readStructureBytes, readMap, hasMap, setYRange, applySuggestedRange,
    getChunks: () => world?.chunks ?? [],
    getWorld: () => world,
    getWorldFile: () => worldFile,
    getLastSelection: () => lastSelection,
    setScanFocus, fillGridWindow, loadForecast, answerMemWarn, restoreLoad, setDimension,
    dismissStopped: () => { state.stopped = null },
    dismissOldWorld: () => { state.oldWorld = false }
  }
}
