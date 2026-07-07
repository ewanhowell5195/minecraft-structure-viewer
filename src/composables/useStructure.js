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

// What is loaded: one structure behaves as before (sessions, levels), while
// shift/ctrl-clicking more structures packs them all into one combined scene.
// Every loader funnels into apply(), which hands off to the build.
const packs = usePacks()
const structures = useStructures()
const buildApi = useBuild()
const session = useSession()
const { locked, withLock } = useLock()

const structure = buildApi.current
const state = reactive({ name: "", error: "" })

// [{ structure, name, rel? }]: rel present when it came from the vanilla tree
let loaded = []

const setVanillaParam = rel => {
  const u = new URL(location)
  rel ? u.searchParams.set("vanilla", rel) : u.searchParams.delete("vanilla")
  // a load resets any level session; its params must not leak to the next one
  u.searchParams.delete("seed")
  u.searchParams.delete("level")
  u.searchParams.delete("debug")
  history.replaceState(null, "", u)
}

// shelf-pack the loaded structures into a compact grid. each cell is the
// structure's floor grid (footprint + 3-block border, padded even) and
// neighbouring grids sit 3 blocks apart. returns one combined structure with
// __parts describing where each one landed
function packLoaded() {
  const GAP = 3
  const cells = loaded.map(({ structure: s }) => ({
    s,
    gw: s.size[0] + 6 + (s.size[0] % 2),
    gd: s.size[2] + 6 + (s.size[2] % 2)
  }))
  const rowMax = Math.max(Math.ceil(Math.sqrt(cells.reduce((a, c) => a + c.gw * c.gd, 0))), ...cells.map(c => c.gw))
  let x = 0, z = 0, rowD = 0
  const parts = []
  for (const c of cells) {
    if (x > 0 && x + c.gw > rowMax) {
      z += rowD + GAP
      x = 0
      rowD = 0
    }
    parts.push({ s: c.s, off: [x + 3, 0, z + 3], size: c.s.size })
    x += c.gw + GAP
    rowD = Math.max(rowD, c.gd)
  }
  const palette = [], byKey = new Map()
  const stateFor = e => {
    const k = e.Name + "|" + JSON.stringify(e.Properties ?? null)
    let i = byKey.get(k)
    if (i === undefined) {
      i = palette.length
      palette.push(e.Properties ? { Name: e.Name, Properties: e.Properties } : { Name: e.Name })
      byKey.set(k, i)
    }
    return i
  }
  const blocks = []
  let mx = 1, my = 1, mz = 1
  for (const p of parts) {
    const map = p.s.palette.map(e => e?.Name ? stateFor(e) : 0)
    for (const b of p.s.blocks) {
      const block = { state: map[b.state], pos: [b.pos[0] + p.off[0], b.pos[1] + p.off[1], b.pos[2] + p.off[2]] }
      if (b.nbt) block.nbt = b.nbt
      blocks.push(block)
    }
    mx = Math.max(mx, p.off[0] + p.size[0])
    my = Math.max(my, p.off[1] + p.size[1])
    mz = Math.max(mz, p.off[2] + p.size[2])
  }
  return {
    size: [mx, my, mz],
    palette, blocks,
    __parts: parts.map(({ off, size }) => ({ off, size }))
  }
}

// rebuild whatever is loaded: one structure gets its session back, several
// become a packed combination (no sessions, url lists them all)
async function apply(refit = true) {
  if (!loaded.length) return
  if (loaded.length === 1) {
    const { structure: s, name, rel } = loaded[0]
    state.name = name
    structures.stateMut.selected = rel ?? null
    if (rel) setVanillaParam(rel)
    await buildApi.build(s, refit)
    await session.startSession(s, name)
  } else {
    state.name = "combination"
    structures.stateMut.selected = null
    const rels = loaded.map(e => e.rel)
    setVanillaParam(rels.every(Boolean) ? rels.join(",") : null)
    session.endSession()
    await buildApi.build(packLoaded(), refit)
  }
}

async function readVanilla(rel) {
  const zp = structures.zipPathOf(rel)
  if (!zp) return null
  const lib = await loadLibrary()
  return readStructure(await lib.readFile(zp, packs.assets.value))
}

// additive (shift/ctrl-click) keeps what is already there
function loadVanilla(rel, additive = false) {
  if (locked.value) return
  return withLock(async () => {
    state.error = ""
    try {
      const s = await readVanilla(rel)
      if (!s) return
      const entry = { structure: s, name: rel, rel }
      if (additive && loaded.length) loaded.push(entry)
      else loaded = [entry]
      await apply()
    } catch (err) {
      state.error = `couldn't load structure: ${err}`
    }
  })
}

// startup with ?vanilla=a,b,c: load the whole set in one build
function loadMany(rels) {
  if (locked.value) return
  return withLock(async () => {
    state.error = ""
    try {
      const entries = []
      for (const rel of rels) {
        const s = await readVanilla(rel)
        if (s) entries.push({ structure: s, name: rel, rel })
      }
      if (!entries.length) return
      loaded = entries
      await apply()
    } catch (err) {
      state.error = `couldn't load structures: ${err}`
    }
  })
}

// ?debug: the generated mesher test scene (src/debug.js), no files needed.
// a value picks a sub-scene, e.g. ?debug=fluid
function loadDebug(kind) {
  if (locked.value) return
  kind = kind && kind !== "1" ? kind : ""
  return withLock(async () => {
    state.error = ""
    const name = kind ? `debug (${kind})` : "debug"
    setVanillaParam(null)
    const u = new URL(location)
    u.searchParams.set("debug", kind || "1")
    history.replaceState(null, "", u)
    loaded = [{ structure: makeDebug(kind), name }]
    await apply()
  })
}

function loadFile(file) {
  if (!file || locked.value) return
  return withLock(async () => {
    state.error = ""
    try {
      const reader = READERS[file.name.split(".").pop().toLowerCase()] ?? readStructure
      const s = await reader(await file.arrayBuffer())
      setVanillaParam(null)
      loaded = [{ structure: s, name: file.name.replace(/\.(nbt|litematic|schem|mcstructure)$/i, "") }]
      await apply()
    } catch (err) {
      state.error = `couldn't read ${file.name}: ${err}`
    }
  })
}

// pack change: vanilla structures re-read from the new assets (their blocks
// may differ per jar); anything else rebuilds in place
async function onAssetsSwapped() {
  if (loaded.length === 1 && loaded[0].rel && structures.has(loaded[0].rel)) {
    try {
      const s = await readVanilla(loaded[0].rel)
      if (s) {
        loaded[0].structure = s
        if (!await session.rebase(s, loaded[0].rel)) await buildApi.build(s, false)
        return
      }
    } catch {}
  } else if (loaded.length > 1) {
    for (const e of loaded) {
      if (!e.rel || !structures.has(e.rel)) continue
      try {
        const s = await readVanilla(e.rel)
        if (s) e.structure = s
      } catch {}
    }
    await buildApi.build(packLoaded(), false)
    return
  }
  // no args: rebuild the build's own source (current may be a display strip)
  if (structure.value) await buildApi.build(undefined, false)
}
packs.setSwapHandler(onAssetsSwapped)

export function useStructure() {
  return { state: readonly(state), structure, loadVanilla, loadMany, loadFile, loadDebug }
}
