import { reactive, readonly, shallowRef } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useStructures } from "./useStructures.js"
import { useBuild } from "./useBuild.js"
import { useSession } from "./useSession.js"
import { useLock } from "./useLock.js"
import { readStructure } from "../nbt.js"
import { readLitematic, readMcstructure, readSchem } from "../formats.js"
import { useWorld } from "./useWorld.js"
import { fixBuiltin, GENERATED } from "../generators/builtin.js"
import { makeDebug } from "../debug.js"
import { yieldTask } from "../yield.js"
import { useFeatures } from "./useFeatures.js"
import { generateFeature } from "../features/index.js"
import { mix, rand32, rnd } from "../transforms.js"

const READERS = { nbt: readStructure, litematic: readLitematic, schem: readSchem, mcstructure: readMcstructure }
const COMBINE_AIR = /(^|:)(air|cave_air|void_air|structure_void)$/

const packs = usePacks()
const structures = useStructures()
const buildApi = useBuild()
const session = useSession()
const { locked, withLock } = useLock()

const structure = buildApi.current
const state = reactive({ name: "", error: "", reading: null, field: null })

let loaded = []

let cancelRead = false
function cancelReading() { cancelRead = true }
async function readMany(rels, reuse, mk) {
  mk ??= async rel => {
    const s = await readVanilla(rel)
    return s ? { structure: s, name: rel, rel } : null
  }
  cancelRead = false
  state.reading = { done: 0, total: rels.length }
  try {
    const entries = []
    for (const rel of rels) {
      const e = reuse?.get(rel) ?? await mk(rel)
      if (e) entries.push(e)
      if (++state.reading.done % 25 === 0) {
        await yieldTask()
        if (cancelRead) return null
      }
    }
    return entries
  } finally {
    state.reading = null
  }
}

// structure names never start with "!", so the marker is unambiguous
async function encodeRels(rels) {
  const stream = new Blob([rels.join(",")]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return "!" + btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

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

export function parseSeedParam(param) {
  if (param == null || !/^[0-9a-f]{1,8}$/i.test(param)) return undefined
  return parseInt(param, 16) >>> 0
}

// the first load and popstate-driven loads replace instead of pushing, so
// history never gains duplicate or looping entries
let seededHistory = false
let navigatingHistory = false

function setVanillaParam(rel, featureRel, featureSeed, featureField) {
  if (navigatingHistory) return
  const u = new URL(location)
  const before = u.searchParams.get("vanilla") + "|" + u.searchParams.get("feature")
  rel ? u.searchParams.set("vanilla", rel) : u.searchParams.delete("vanilla")
  featureRel ? u.searchParams.set("feature", featureRel) : u.searchParams.delete("feature")
  featureRel && featureSeed ? u.searchParams.set("fseed", featureSeed.toString(16)) : u.searchParams.delete("fseed")
  featureRel && featureField ? u.searchParams.set("field", "1") : u.searchParams.delete("field")
  // a load resets any level session; its params must not leak to the next one
  u.searchParams.delete("seed")
  u.searchParams.delete("level")
  u.searchParams.delete("debug")
  const changed = u.searchParams.get("vanilla") + "|" + u.searchParams.get("feature") !== before
  if (changed && seededHistory) history.pushState(null, "", u)
  else history.replaceState(null, "", u)
  seededHistory = true
}

addEventListener("popstate", async () => {
  const params = new URLSearchParams(location.search)
  navigatingHistory = true
  try {
    const debug = params.get("debug")
    if (debug != null) {
      await loadDebug(debug)
      return
    }
    const feature = params.get("feature")
    if (feature != null) {
      const fseed = parseSeedParam(params.get("fseed"))
      if (feature.includes(",")) await loadFeatures(feature.split(","))
      else if (params.get("field") != null) await loadFeatureField(feature, fseed)
      else await loadFeature(feature, fseed)
      return
    }
    const rels = (await decodeVanillaParam(params.get("vanilla"))).filter(r => structures.has(r))
    if (rels.length > 1) await loadMany(rels)
    else if (rels.length === 1) await loadVanilla(rels[0])
  } finally {
    navigatingHistory = false
  }
})

async function packLoaded() {
  const GAP = 3
  const paths = loaded.map(e => e.name.split("/"))
  let common = 0
  while (paths.every(p => p.length - 1 > common && p[common] === paths[0][common])) common++
  const cells = loaded.map(({ structure: s }, i) => ({
    s,
    name: paths[i].slice(common).join("/"),
    gw: s.size[0] + 6,
    gd: s.size[2] + 6
  }))
  const W = Math.max(Math.ceil(Math.sqrt(cells.reduce((a, c) => a + (c.gw + GAP) * (c.gd + GAP), 0))), ...cells.map(c => c.gw))
  const placed = []
  const B = 128
  const buckets = new Map()
  function addRect(p) {
    for (let bx = Math.floor(p.x / B); bx <= Math.floor((p.x + p.w) / B); bx++)
      for (let bz = Math.floor(p.z / B); bz <= Math.floor((p.z + p.d) / B); bz++) {
        const k = bx + "," + bz
        let arr = buckets.get(k)
        if (!arr) buckets.set(k, arr = [])
        arr.push(p)
      }
  }
  let stamp = 0
  function fits(x, z, w, d) {
    if (x < 0 || x + w > W) return false
    stamp++
    for (let bx = Math.floor((x - GAP) / B); bx <= Math.floor((x + w + GAP) / B); bx++)
      for (let bz = Math.floor((z - GAP) / B); bz <= Math.floor((z + d + GAP) / B); bz++) {
        const arr = buckets.get(bx + "," + bz)
        if (!arr) continue
        for (const p of arr) {
          if (p.stamp === stamp) continue
          p.stamp = stamp
          if (x < p.x + p.w + GAP && p.x < x + w + GAP && z < p.z + p.d + GAP && p.z < z + d + GAP) return false
        }
      }
    return true
  }
  const parts = []
  let sliceT = performance.now()
  for (const c of cells) {
    if (performance.now() - sliceT > 40) {
      await yieldTask()
      sliceT = performance.now()
    }
    const candidates = [[0, 0]]
    for (const p of placed) candidates.push([p.x + p.w + GAP, p.z], [p.x, p.z + p.d + GAP])
    let best = null
    for (const [x, z] of candidates) {
      if (best && (z > best[1] || (z === best[1] && x >= best[0]))) continue
      if (!fits(x, z, c.gw, c.gd)) continue
      best = [x, z]
    }
    best ??= [0, Math.max(0, ...placed.map(p => p.z + p.d + GAP))]
    const rect = { x: best[0], z: best[1], w: c.gw, d: c.gd }
    placed.push(rect)
    addRect(rect)
    parts.push({ s: c.s, name: c.name, off: [best[0] + 3, 0, best[1] + 3], size: c.s.size })
  }
  return mergeParts(parts)
}

async function packField() {
  const GAP = 3
  const innerW = Math.max(...loaded.map(e => e.structure.size[0]))
  const innerD = Math.max(...loaded.map(e => e.structure.size[2]))
  const cellW = innerW + 6, cellD = innerD + 6
  const cols = Math.ceil(Math.sqrt(loaded.length))
  const parts = loaded.map((e, i) => ({
    s: e.structure,
    off: [
      (i % cols) * (cellW + GAP) + 3 + Math.floor((innerW - e.structure.size[0]) / 2),
      0,
      Math.floor(i / cols) * (cellD + GAP) + 3 + Math.floor((innerD - e.structure.size[2]) / 2)
    ],
    size: e.structure.size
  }))
  return mergeParts(parts)
}

async function mergeParts(parts) {
  const palette = [], byKey = new Map()
  function stateFor(e) {
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
  const entities = []
  let mx = 1, my = 1, mz = 1
  let merged = 0
  for (const p of parts) {
    if (++merged % 40 === 0) await yieldTask()
    const map = p.s.palette.map(e => e?.Name ? stateFor(e) : 0)
    // air culls like absence, so dropping it is lossless and shrinks all-structure loads
    const drop = p.s.palette.map(e => !e?.Name || COMBINE_AIR.test(e.Name))
    for (const b of p.s.blocks) {
      if (drop[b.state]) continue
      const block = { state: map[b.state], pos: [b.pos[0] + p.off[0], b.pos[1] + p.off[1], b.pos[2] + p.off[2]] }
      if (b.nbt) block.nbt = b.nbt
      blocks.push(block)
    }
    for (const e of p.s.entities ?? []) {
      entities.push({ ...e, pos: [e.pos[0] + p.off[0], e.pos[1] + p.off[1], e.pos[2] + p.off[2]] })
    }
    mx = Math.max(mx, p.off[0] + p.size[0])
    my = Math.max(my, p.off[1] + p.size[1])
    mz = Math.max(mz, p.off[2] + p.size[2])
  }
  return {
    size: [mx, my, mz],
    palette, blocks, entities,
    __parts: parts.map(({ off, size, name }) => ({ off, size, name }))
  }
}

function snapshot() {
  return {
    loaded, anchor, name: state.name, field: state.field, url: location.href,
    selected: Array.from(structures.state.selected),
    fselected: Array.from(useFeatures().state.selected)
  }
}
function restore(snap) {
  loaded = snap.loaded
  anchor = snap.anchor
  state.name = snap.name
  state.field = snap.field
  structures.stateMut.selected = snap.selected
  useFeatures().stateMut.selected = snap.fselected
  history.replaceState(null, "", snap.url)
}

async function apply(refit = true) {
  if (!loaded.length) return
  const features = useFeatures()
  structures.stateMut.selected = loaded.filter(e => e.rel && !e.feature).map(e => e.rel)
  features.stateMut.selected = Array.from(new Set(loaded.filter(e => e.feature).map(e => e.rel)))
  if (state.field) {
    const { rel, base } = state.field
    state.name = `${rel} (field of ${loaded.length})`
    setVanillaParam(null, rel, base === features.defaultSeed(rel) ? 0 : base, true)
    const s = loaded.length === 1 ? loaded[0].structure : await packField()
    if (await buildApi.build(s, refit) === false) return false
    session.endSession()
    return
  }
  if (loaded.length === 1) {
    const { structure: s, name, rel, feature, seed } = loaded[0]
    state.name = name
    if (feature) {
      setVanillaParam(null, rel, seed === features.defaultSeed(rel) ? 0 : seed)
      if (await buildApi.build(s, refit) === false) return false
      session.endSession()
    } else {
      if (rel) setVanillaParam(rel)
      if (await buildApi.build(s, refit) === false) return false
      await session.startSession(s, name)
    }
  } else {
    const allFeatures = loaded.every(e => e.feature)
    const allStructures = loaded.every(e => e.rel && !e.feature)
    state.name = `${loaded.length} ${allFeatures ? "features" : allStructures ? "structures" : "items"}`
    if (allFeatures) setVanillaParam(null, loaded.map(e => e.rel).join(","))
    else if (allStructures) setVanillaParam(await encodeRels(loaded.map(e => e.rel)))
    else setVanillaParam(null)
    if (await buildApi.build(await packLoaded(), refit) === false) return false
    session.endSession()
  }
}

async function readVanilla(rel) {
  const w = useWorld()
  if (w.hasStructure(rel)) return readStructure(await w.readStructureBytes(rel))
  const zp = structures.zipPathOf(rel)
  if (!zp) {
    const gen = GENERATED[rel]
    if (!gen) return null
    return (await gen(undefined, { seed: 0 })).structure
  }
  const lib = await loadLibrary()
  const s = await readStructure(await lib.readFile(zp, packs.assets.value))
  // randomised builtins load deterministically at seed 0; Re-roll picks a fresh seed
  return fixBuiltin(rel, s, 0)
}

// must match TreeFolder's render order (folders before files); shift ranges span it
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
  function walk(node) {
    for (const child of node.dirs.values()) walk(child)
    for (const rel of node.files) order.set(rel, order.size)
  }
  walk(root)
  return order
}

function sortLoaded(order) {
  loaded.sort((a, b) => (order.get(a.rel) ?? Infinity) - (order.get(b.rel) ?? Infinity))
}

let anchor = null
function clickLoad(cat, rel, ev) {
  if (locked.value) return
  const canCombine = loaded.length > 0 && loaded.every(e => e.rel) && !state.field
  const shift = !!ev?.shiftKey && canCombine, ctrl = !!(ev?.ctrlKey || ev?.metaKey) && canCombine
  return withLock(async () => {
    state.error = ""
    const snap = snapshot()
    try {
      const order = cat.order()
      if (shift && anchor != null && anchor !== rel && order.has(anchor) && order.has(rel)) {
        const [lo, hi] = [order.get(anchor), order.get(rel)].sort((a, b) => a - b)
        const range = Array.from(order.entries()).filter(([, i]) => i >= lo && i <= hi).map(([r]) => r)
        const reuse = new Map(loaded.filter(e => e.rel).map(e => [e.rel, e]))
        const entries = await readMany(range, reuse, cat.entry)
        if (!entries?.length) return
        loaded = entries
      } else if (ctrl && loaded.length) {
        const at = loaded.findIndex(e => e.rel === rel)
        if (at >= 0) {
          if (loaded.length === 1) return
          loaded.splice(at, 1)
        } else {
          const e = await cat.entry(rel)
          if (!e) return
          loaded.push(e)
          sortLoaded(order)
        }
        anchor = rel
      } else {
        const e = await cat.entry(rel)
        if (!e) return
        loaded = [e]
        anchor = rel
      }
      state.field = null
      if (await apply() === false) restore(snap)
    } catch (err) {
      state.error = `couldn't load: ${err?.message ?? err}`
    }
  })
}

const structCatalog = {
  order: visualOrder,
  entry: async rel => {
    const s = await readVanilla(rel)
    return s ? { structure: s, name: rel, rel } : null
  }
}

const featureCatalog = {
  order: () => new Map(useFeatures().visibleNames().map((n, i) => [n, i])),
  entry: rel => featureEntry(rel)
}

function loadVanilla(rel, ev) { return clickLoad(structCatalog, rel, ev) }
function clickFeature(rel, ev) { return clickLoad(featureCatalog, rel, ev) }

async function featureEntry(rel, seed) {
  const features = useFeatures()
  const json = await features.readFeature(rel)
  if (!json) return null
  const useSeed = seed ?? features.defaultSeed(rel)
  const loadStruct = async ref => {
    const path = ref.includes(":") ? ref.replace(":", "/") : "minecraft/" + ref
    const zp = structures.zipPathOf(path)
    if (!zp) return null
    const lib = await loadLibrary()
    return readStructure(await lib.readFile(zp, packs.assets.value))
  }
  const s = await generateFeature(rel, json, rnd(useSeed), features.resolvePlaced, loadStruct)
  return s.blocks.length ? { structure: s, name: rel, rel, feature: true, seed: useSeed } : null
}

function loadMany(rels) {
  if (locked.value) return
  return withLock(async () => {
    state.error = ""
    const snap = snapshot()
    try {
      const entries = await readMany([...new Set(rels)])
      if (!entries?.length) return
      state.field = null
      loaded = entries
      sortLoaded(visualOrder())
      anchor = loaded.at(-1)?.rel ?? null
      if (await apply() === false) restore(snap)
    } catch (err) {
      state.error = `couldn't load structures: ${err}`
    }
  })
}

function loadFeature(rel, seed) {
  if (locked.value) return
  return withLock(async () => {
    state.error = ""
    const snap = snapshot()
    try {
      const e = await featureEntry(rel, seed)
      if (!e) return
      state.field = null
      loaded = [e]
      anchor = rel
      if (await apply() === false) restore(snap)
    } catch (err) {
      state.error = `couldn't generate ${rel}: ${err?.message ?? err}`
    }
  })
}

function loadFeatures(rels, reroll = false) {
  if (locked.value) return
  return withLock(async () => {
    state.error = ""
    const snap = snapshot()
    try {
      const entries = await readMany(Array.from(new Set(rels)), undefined,
        rel => featureEntry(rel, reroll ? rand32() : undefined))
      if (!entries?.length) return
      state.field = null
      loaded = entries
      anchor = loaded.at(-1)?.rel ?? null
      if (await apply() === false) restore(snap)
    } catch (err) {
      state.error = `couldn't generate features: ${err?.message ?? err}`
    }
  })
}

const FIELD_N = 256

function shapeKey(s) {
  const rows = s.blocks.map(b => {
    const e = s.palette[b.state]
    return `${b.pos[0] - s.anchor[0]},${b.pos[1]},${b.pos[2] - s.anchor[2]}|${e.Name}|${e.Properties ? JSON.stringify(e.Properties) : ""}`
  })
  return rows.sort().join("\n")
}

function loadFeatureField(rel, baseSeed) {
  if (locked.value) return
  const features = useFeatures()
  return withLock(async () => {
    state.error = ""
    const snap = snapshot()
    try {
      const current = loaded.length === 1 && loaded[0].feature && loaded[0].rel === rel ? loaded[0].seed : undefined
      const base = baseSeed ?? current ?? features.defaultSeed(rel)
      cancelRead = false
      state.reading = { done: 0, total: FIELD_N }
      const entries = []
      const seen = new Set()
      try {
        for (let i = 0; i < FIELD_N; i++) {
          const seed = i === 0 ? base : mix(base, i) >>> 0
          const e = await featureEntry(rel, seed)
          if (e) {
            const key = shapeKey(e.structure)
            if (!seen.has(key)) {
              seen.add(key)
              entries.push(e)
            }
          }
          if (++state.reading.done % 8 === 0) {
            await yieldTask()
            if (cancelRead) return
          }
        }
      } finally {
        state.reading = null
      }
      if (!entries.length) return
      entries.sort((a, b) => a.structure.blocks.length - b.structure.blocks.length || a.seed - b.seed)
      state.field = { rel, base }
      loaded = entries
      anchor = rel
      if (await apply() === false) restore(snap)
    } catch (err) {
      state.error = `couldn't generate ${rel} field: ${err?.message ?? err}`
    }
  })
}

function loadDebug(kind) {
  if (locked.value) return
  kind = kind && kind !== "1" ? kind : ""
  return withLock(async () => {
    state.error = ""
    const snap = snapshot()
    const name = kind ? `debug (${kind})` : "debug"
    setVanillaParam(null)
    const u = new URL(location)
    u.searchParams.set("debug", kind || "1")
    history.replaceState(null, "", u)
    state.field = null
    loaded = [{ structure: makeDebug(kind), name }]
    if (await apply() === false) restore(snap)
  })
}

function loadFile(file) {
  if (!file || locked.value) return
  return withLock(async () => {
    state.error = ""
    const snap = snapshot()
    try {
      const reader = READERS[file.name.split(".").pop().toLowerCase()] ?? readStructure
      const s = await reader(await file.arrayBuffer())
      setVanillaParam(null)
      state.field = null
      loaded = [{ structure: s, name: file.name.replace(/\.(nbt|litematic|schem|mcstructure)$/i, "") }]
      if (await apply() === false) restore(snap)
    } catch (err) {
      state.error = `couldn't read ${file.name}: ${err}`
    }
  })
}

function loadObject(structure, name) {
  if (!structure || locked.value) return
  return withLock(async () => {
    state.error = ""
    const snap = snapshot()
    try {
      setVanillaParam(null)
      state.field = null
      loaded = [{ structure, name }]
      if (await apply() === false) restore(snap)
    } catch (err) {
      state.error = `couldn't load ${name}: ${err}`
    }
  })
}

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
    await buildApi.build(await packLoaded(), false)
    return
  }
  // no args: rebuild the build's own source (current may be a display strip)
  if (structure.value) await buildApi.build(undefined, false)
}
packs.setSwapHandler(onAssetsSwapped)

export function useStructure() {
  return { state: readonly(state), structure, loadVanilla, loadMany, loadFile, loadObject, loadDebug, loadFeature, loadFeatures, loadFeatureField, clickFeature, cancelReading }
}
