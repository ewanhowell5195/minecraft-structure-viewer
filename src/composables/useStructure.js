import { reactive, readonly, shallowRef } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useStructures } from "./useStructures.js"
import { useBuild } from "./useBuild.js"
import { useLock } from "./useLock.js"
import { readStructure } from "../nbt.js"

// The currently loaded structure: loading + selection + the ?vanilla= param.
// Every loader funnels into loadStructure, which hands off to the build.
const packs = usePacks()
const structures = useStructures()
const buildApi = useBuild()
const { locked, withLock } = useLock()

const structure = buildApi.current
const state = reactive({ name: "", error: "" })

const setVanillaParam = rel => {
  const u = new URL(location)
  rel ? u.searchParams.set("vanilla", rel) : u.searchParams.delete("vanilla")
  history.replaceState(null, "", u)
}

async function loadStructure(s, refit = true) {
  if (!s) return
  await buildApi.build(s, refit)
}

async function readVanilla(rel) {
  const zp = structures.zipPathOf(rel)
  if (!zp) return null
  const lib = await loadLibrary()
  return readStructure(await lib.readFile(zp, packs.assets.value))
}

function loadVanilla(rel) {
  if (locked.value) return
  return withLock(async () => {
    state.error = ""
    try {
      const s = await readVanilla(rel)
      if (!s) return
      state.name = rel
      structures.stateMut.selected = rel
      setVanillaParam(rel)
      await loadStructure(s)
    } catch (err) {
      state.error = `couldn't load structure: ${err}`
    }
  })
}

function loadFile(file) {
  if (!file || locked.value) return
  return withLock(async () => {
    state.error = ""
    try {
      const s = await readStructure(await file.arrayBuffer())
      state.name = file.name.replace(/\.nbt$/, "")
      structures.stateMut.selected = null
      setVanillaParam(null)
      await loadStructure(s)
    } catch (err) {
      state.error = `couldn't read ${file.name}: ${err}`
    }
  })
}

// pack change: a selected vanilla structure re-reads from the new assets (its
// blocks may differ per jar); anything else rebuilds in place
async function onAssetsSwapped() {
  const sel = structures.state.selected
  if (sel && structures.has(sel)) {
    try {
      const s = await readVanilla(sel)
      if (s) { await buildApi.build(s, false, true); return }
    } catch {}
  }
  if (structure.value) await buildApi.build(structure.value, false)
}
packs.setSwapHandler(onAssetsSwapped)

export function useStructure() {
  return { state: readonly(state), structure, loadVanilla, loadFile }
}
