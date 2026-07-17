import { reactive, readonly } from "vue"
import { readWorldZip, readRegionFile, buildSelection, unzipEntry, chunkSurface } from "../world.js"
import { useStructure } from "./useStructure.js"
import { useBuild } from "./useBuild.js"
import { useStructures } from "./useStructures.js"
import { cacheFile, uncache } from "../userCache.js"

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
  regionFile: false,
  rev: 0,
  yMin: 60,
  yMax: 100
})

let world = null
const selected = new Set()

const surface = new Map()
let queue = [], qi = 0
let focusTimer = null
let lastFocus = ""
let pumping = false

function setScanFocus(x0, z0, x1, z1) {
  const key = x0 + "," + z0 + "," + x1 + "," + z1
  if (key === lastFocus) return
  lastFocus = key
  clearTimeout(focusTimer)
  focusTimer = setTimeout(() => {
    if (!world) return
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
      try { surface.set(key, await chunkSurface(w, c)) } catch {}
    }
    const now = performance.now()
    if (now - t0 > 12) {
      if (now - lastRev > 200) { state.rev++; lastRev = now }
      await new Promise(r => setTimeout(r))
      t0 = performance.now()
    }
  }
  pumping = false
  if (world === w) state.rev++
}

function fillGridWindow(d, w0x, w0z, size, tpc) {
  d.fill(0)
  if (!world) return
  const span = size / tpc
  for (const c of world.chunks) {
    const key = c.cx + "," + c.cz
    const s = surface.get(key)
    if (s === null) continue
    const sel = selected.has(key) ? 128 : 0
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
  state.name = file.name.replace(/\.(zip|mca)$/i, "")
  state.loading = { done: 0, total: 0 }
  surface.clear()
  queue = []
  qi = 0
  lastFocus = ""
  try {
    state.regionFile = /\.mca$/i.test(file.name)
    world = state.regionFile
      ? readRegionFile(await file.arrayBuffer(), file.name)
      : await readWorldZip(await file.arrayBuffer(), (done, total) => { state.loading = { done, total } })
    selected.clear()
    state.name = world.name || file.name.replace(/\.(zip|mca)$/i, "")
    state.chunkCount = world.chunks.length
    state.selCount = 0
    useStructures().setWorldStructures([...world.structures.keys()])
    if (cacheIt) cacheFile("world", file)
  } catch (err) {
    world = null
    useStructures().setWorldStructures([])
    state.name = file.name.replace(/\.(zip|mca)$/i, "")
    state.chunkCount = 0
    state.selCount = 0
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
  } else {
    u.searchParams.delete("wy")
    u.searchParams.delete("wsel")
    u.searchParams.delete("wloaded")
  }
  history.replaceState(null, "", u)
}

async function restoreLoad(wy, wsel) {
  if (!world) return
  const [lo, hi] = (wy ?? "").split(",").map(Number)
  if (Number.isFinite(lo) && Number.isFinite(hi)) setYRange(lo, hi)
  selected.clear()
  for (const key of await unpackSel(wsel)) if (key) selected.add(key)
  state.selCount = selected.size
  state.rev++
  if (!selected.size) return
  let probe
  try { probe = await buildSelection(world, selected, { yMin: state.yMin, yMax: state.yMax, cap: 24000 }) } catch { return }
  if (probe.capped && !await useBuild().restoreGateCheck(probe.blocks.length)) return
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
    const s = await buildSelection(world, selected, { yMin: state.yMin, yMax: state.yMax, budget: ios ? 0.6e9 : 1.6e9 },
      (done, total) => {
        sApi.setReading({ done, total, label: "reading chunks" })
        return !sApi.readCancelled()
      })
    sApi.setReading(null)
    const n = s.truncated ? s.chunksLoaded : selected.size
    await sApi.loadObject(s, `${state.name} · ${n} chunk${n === 1 ? "" : "s"}`, true)
    if (s.truncated) state.stopped = { loaded: s.chunksLoaded, total: s.chunksTotal }
    setWorldParams(true)
  } catch (err) {
    if (err?.message !== "cancelled") state.error = String(err.message ?? err)
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
  useStructures().setWorldStructures([])
  uncache("world")
  setWorldParams(false)
}

function loadForecast() {
  if (!selected.size) return false
  const est = selected.size * 256 * (state.yMax - state.yMin + 1) * 120
  const mem = performance.memory
  const ios = /iPhone|iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  const headroom = mem ? mem.jsHeapSizeLimit - mem.usedJSHeapSize : ios ? 0.6e9 : 1.6e9
  return est > headroom * 0.8
}

const hasStructure = rel => !!world?.structures.has(rel)
const readStructureBytes = rel => unzipEntry(world.structures.get(rel))

function setYRange(lo, hi) {
  state.yMin = Math.min(lo, hi)
  state.yMax = Math.max(lo, hi)
}

export function useWorld() {
  return {
    state: readonly(state), openWorld, toggleChunk, isSelected, clearSelection, selectRect, rectHasSelected, loadSelected, closeWorld,
    hasStructure, readStructureBytes, setYRange,
    getChunks: () => world?.chunks ?? [],
    setScanFocus, fillGridWindow, loadForecast, answerMemWarn, restoreLoad,
    dismissStopped: () => { state.stopped = null }
  }
}
