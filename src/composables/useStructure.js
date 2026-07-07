import { reactive, readonly, shallowRef } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useStructures } from "./useStructures.js"
import { useBuild } from "./useBuild.js"
import { useSession } from "./useSession.js"
import { useLock } from "./useLock.js"
import { readStructure } from "../nbt.js"
import { readLitematic, readMcstructure, readSchem } from "../formats.js"
import { makeDebug } from "../debug.js"

const READERS = { nbt: readStructure, litematic: readLitematic, schem: readSchem, mcstructure: readMcstructure }

// The currently loaded structure: loading + selection + the ?vanilla= param.
// Every loader funnels into loadStructure, which hands off to the build.
const packs = usePacks()
const structures = useStructures()
const buildApi = useBuild()
const session = useSession()
const { locked, withLock } = useLock()

const structure = buildApi.current
const state = reactive({ name: "", error: "" })

const setVanillaParam = rel => {
  const u = new URL(location)
  rel ? u.searchParams.set("vanilla", rel) : u.searchParams.delete("vanilla")
  // a load resets any level session; its params must not leak to the next one
  u.searchParams.delete("seed")
  u.searchParams.delete("level")
  u.searchParams.delete("debug")
  history.replaceState(null, "", u)
}

async function loadStructure(s, name, refit = true) {
  if (!s) return
  await buildApi.build(s, refit)
  await session.startSession(s, name)
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
      await loadStructure(s, rel)
    } catch (err) {
      state.error = `couldn't load structure: ${err}`
    }
  })
}

// ?debug: the generated mesher test scene (src/debug.js), no files needed
function loadDebug() {
  if (locked.value) return
  return withLock(async () => {
    state.error = ""
    state.name = "debug"
    structures.stateMut.selected = null
    setVanillaParam(null)
    const u = new URL(location)
    u.searchParams.set("debug", "1")
    history.replaceState(null, "", u)
    await loadStructure(makeDebug(), "debug")
  })
}

function loadFile(file) {
  if (!file || locked.value) return
  return withLock(async () => {
    state.error = ""
    try {
      const reader = READERS[file.name.split(".").pop().toLowerCase()] ?? readStructure
      const s = await reader(await file.arrayBuffer())
      state.name = file.name.replace(/\.(nbt|litematic|schem|mcstructure)$/i, "")
      structures.stateMut.selected = null
      setVanillaParam(null)
      await loadStructure(s, state.name)
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
      if (s) {
        if (!await session.rebase(s, sel)) await buildApi.build(s, false, true)
        return
      }
    } catch {}
  }
  // no args: rebuild the build's own source (current may be a display strip)
  if (structure.value) await buildApi.build(undefined, false)
}
packs.setSwapHandler(onAssetsSwapped)

export function useStructure() {
  return { state: readonly(state), structure, loadVanilla, loadFile, loadDebug }
}
