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

// multi-structure lists are deflate + base64url encoded ("!<data>") to keep
// the url short: the shared path prefixes compress well. structure names
// never start with "!", so the marker is unambiguous
async function encodeRels(rels) {
  const stream = new Blob([rels.join(",")]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return "!" + btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

// accepts either form: plain single/comma names or the encoded list
export async function decodeVanillaParam(param) {
  if (!param) return []
  if (!param.startsWith("!")) return param.split(",")
  try {
    const bin = atob(param.slice(1).replaceAll("-", "+").replaceAll("_", "/"))
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    return (await new Response(stream).text()).split(",")
  } catch {
    return []
  }
}

const setVanillaParam = rel => {
  const u = new URL(location)
  rel ? u.searchParams.set("vanilla", rel) : u.searchParams.delete("vanilla")
  // a load resets any level session; its params must not leak to the next one
  u.searchParams.delete("seed")
  u.searchParams.delete("level")
  u.searchParams.delete("debug")
  history.replaceState(null, "", u)
}

// pack the loaded structures into a compact grid. each cell is the
// structure's floor grid (footprint + 3-block border, padded even) and
// neighbouring grids sit 3 blocks apart. bottom-left packing in tree order:
// each grid takes the frontmost (then leftmost) pocket it fits in, so small
// grids fill the space beside big ones. returns one combined structure with
// __parts describing where each one landed
function packLoaded() {
  const GAP = 3
  const cells = loaded.map(({ structure: s }) => ({
    s,
    gw: s.size[0] + 6 + (s.size[0] % 2),
    gd: s.size[2] + 6 + (s.size[2] % 2)
  }))
  const W = Math.max(Math.ceil(Math.sqrt(cells.reduce((a, c) => a + (c.gw + GAP) * (c.gd + GAP), 0))), ...cells.map(c => c.gw))
  const placed = []
  const fits = (x, z, w, d) =>
    x >= 0 && x + w <= W &&
    !placed.some(p => x < p.x + p.w + GAP && p.x < x + w + GAP && z < p.z + p.d + GAP && p.z < z + d + GAP)
  const parts = []
  for (const c of cells) {
    const candidates = [[0, 0]]
    for (const p of placed) candidates.push([p.x + p.w + GAP, p.z], [p.x, p.z + p.d + GAP])
    let best = null
    for (const [x, z] of candidates) {
      if (!fits(x, z, c.gw, c.gd)) continue
      if (!best || z < best[1] || (z === best[1] && x < best[0])) best = [x, z]
    }
    best ??= [0, Math.max(0, ...placed.map(p => p.z + p.d + GAP))]
    placed.push({ x: best[0], z: best[1], w: c.gw, d: c.gd })
    parts.push({ s: c.s, off: [best[0] + 3, 0, best[1] + 3], size: c.s.size })
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
    structures.stateMut.selected = rel ? [rel] : []
    if (rel) setVanillaParam(rel)
    await buildApi.build(s, refit)
    await session.startSession(s, name)
  } else {
    state.name = "combination"
    const rels = loaded.map(e => e.rel)
    structures.stateMut.selected = rels.filter(Boolean)
    setVanillaParam(rels.every(Boolean) ? await encodeRels(rels) : null)
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

// the sidebar's visual order: with a search active it is the flat result
// list, otherwise the tree (folders before files at every level, same as
// TreeFolder renders). loads always sort into this order, and shift ranges
// span it, across folder boundaries
function visualOrder() {
  const names = structures.visibleNames()
  if (structures.state.filterText.trim()) return new Map(names.map((n, i) => [n, i]))
  const root = { dirs: new Map(), files: [] }
  for (const rel of names) {
    const parts = rel.split("/")
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] })
      node = node.dirs.get(parts[i])
    }
    node.files.push(rel)
  }
  const order = new Map()
  const walk = node => {
    for (const child of node.dirs.values()) walk(child)
    for (const rel of node.files) order.set(rel, order.size)
  }
  walk(root)
  return order
}

function sortLoaded(order) {
  loaded.sort((a, b) => (order.get(a.rel) ?? Infinity) - (order.get(b.rel) ?? Infinity))
}

// plain click loads one; ctrl-click toggles membership; shift-click loads the
// whole tree range between the last plain/ctrl click and here
let anchor = null
function loadVanilla(rel, ev) {
  if (locked.value) return
  const shift = !!ev?.shiftKey, ctrl = !!(ev?.ctrlKey || ev?.metaKey)
  return withLock(async () => {
    state.error = ""
    try {
      const order = visualOrder()
      if (shift && anchor != null && anchor !== rel && order.has(anchor) && order.has(rel)) {
        const [lo, hi] = [order.get(anchor), order.get(rel)].sort((a, b) => a - b)
        const range = [...order.entries()].filter(([, i]) => i >= lo && i <= hi).map(([r]) => r)
        const entries = []
        for (const r of range) {
          const existing = loaded.find(e => e.rel === r)
          const s = existing?.structure ?? await readVanilla(r)
          if (s) entries.push({ structure: s, name: r, rel: r })
        }
        if (!entries.length) return
        loaded = entries
      } else if (ctrl && loaded.length) {
        const at = loaded.findIndex(e => e.rel === rel)
        if (at >= 0) {
          if (loaded.length === 1) return
          loaded.splice(at, 1)
        } else {
          const s = await readVanilla(rel)
          if (!s) return
          loaded.push({ structure: s, name: rel, rel })
          sortLoaded(order)
        }
        anchor = rel
      } else {
        const s = await readVanilla(rel)
        if (!s) return
        loaded = [{ structure: s, name: rel, rel }]
        anchor = rel
      }
      await apply()
    } catch (err) {
      state.error = `couldn't load structure: ${err}`
    }
  })
}

// startup with an encoded ?vanilla list: load the whole set in one build
function loadMany(rels) {
  if (locked.value) return
  return withLock(async () => {
    state.error = ""
    try {
      const entries = []
      for (const rel of new Set(rels)) {
        const s = await readVanilla(rel)
        if (s) entries.push({ structure: s, name: rel, rel })
      }
      if (!entries.length) return
      loaded = entries
      sortLoaded(visualOrder())
      anchor = loaded.at(-1)?.rel ?? null
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
