import { reactive, readonly } from "vue"
import { readWorldZip, readRegionFile, buildSelection, unzipEntry, chunkSurface } from "../world.js"
import { useStructure } from "./useStructure.js"
import { useStructures } from "./useStructures.js"
import { cacheFile, uncache } from "../userCache.js"

const state = reactive({
  active: false,
  name: "",
  chunkCount: 0,
  selCount: 0,
  error: "",
  busy: false,
  rev: 0,
  yMin: 60,
  yMax: 100
})

let world = null
const selected = new Set() // "cx,cz"

const surface = new Map()
let queue = [], qi = 0
let focusTimer = null
let pumping = false

function setScanFocus(x0, z0, x1, z1) {
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

function fillGridWindow(d, w0x, w0z, size) {
  d.fill(0)
  if (!world) return
  const span = size / 8
  for (const c of world.chunks) {
    const key = c.cx + "," + c.cz
    const s = surface.get(key)
    const sel = selected.has(key) ? 32 : 0
    const bx = c.cx - w0x, bz = c.cz - w0z
    if (bx < 0 || bz < 0 || bx >= span || bz >= span) continue
    const t0 = (bz * 8) * size + bx * 8
    for (let sz = 0; sz < 8; sz++) for (let sx = 0; sx < 8; sx++) {
      d[t0 + sz * size + sx] = (s ? s[sz * 8 + sx] : 1) | sel
    }
  }
}

async function openWorld(file, cacheIt = true) {
  state.error = ""
  state.busy = true
  surface.clear()
  queue = []
  qi = 0
  try {
    world = /\.mca$/i.test(file.name)
      ? readRegionFile(await file.arrayBuffer(), file.name)
      : await readWorldZip(await file.arrayBuffer())
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
    state.active = true
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

async function loadSelected() {
  if (!world || !selected.size) return
  state.error = ""
  state.busy = true
  try {
    const s = await buildSelection(world, selected, { yMin: state.yMin, yMax: state.yMax })
    const n = selected.size
    await useStructure().loadObject(s, `${state.name} · ${n} chunk${n === 1 ? "" : "s"}`, true)
  } catch (err) {
    state.error = String(err.message ?? err)
  } finally {
    state.busy = false
  }
}

function closeWorld() {
  world = null
  surface.clear()
  queue = []
  qi = 0
  selected.clear()
  state.active = false
  state.selCount = 0
  state.error = ""
  useStructures().setWorldStructures([])
  uncache("world")
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
    setScanFocus, fillGridWindow
  }
}
