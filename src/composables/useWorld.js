import { reactive, readonly } from "vue"
import { readWorldZip, readRegionFile, buildSelection, unzipEntry } from "../world.js"
import { useStructure } from "./useStructure.js"
import { useStructures } from "./useStructures.js"

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

async function openWorld(file) {
  state.error = ""
  state.busy = true
  try {
    world = /\.mca$/i.test(file.name)
      ? readRegionFile(await file.arrayBuffer(), file.name)
      : await readWorldZip(await file.arrayBuffer())
    selected.clear()
    state.name = world.name || file.name.replace(/\.(zip|mca)$/i, "")
    state.chunkCount = world.chunks.length
    state.selCount = 0
    useStructures().setWorldStructures([...world.structures.keys()])
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
    await useStructure().loadObject(s, `${state.name} · ${n} chunk${n === 1 ? "" : "s"}`)
  } catch (err) {
    state.error = String(err.message ?? err)
  } finally {
    state.busy = false
  }
}

function closeWorld() {
  world = null
  selected.clear()
  state.active = false
  state.selCount = 0
  state.error = ""
  useStructures().setWorldStructures([])
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
    getChunks: () => world?.chunks ?? []
  }
}
