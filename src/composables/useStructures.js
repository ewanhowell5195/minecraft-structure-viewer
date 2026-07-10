import { reactive, readonly, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { PROC } from "../proc.js"
import { GENERATED } from "../generators/builtin.js"

// Discovery: every data/<ns>/structure/*.nbt plus the legacy/mod plural
// data/<ns>/structures/*.nbt, across the union of all pack sources. Names are
// "<ns>/<path>"; reads go through readFile(zipPath, assets) so the highest
// priority pack's copy wins.
const STRUCT_RE = /^data\/([^/]+)\/structures?\/(.+)\.nbt$/

const packs = usePacks()

const state = reactive({
  names: [],
  filterText: "",
  filterMode: "all",
  selected: [],
  indexing: false,
  worldgenReady: false
})

// name -> real zip path (the folder may be structure or structures)
let structPath = new Map()
let starterSet = null, standaloneSet = null, structDepth = null, structRadius = null
let worldgenPromise = null

// structure-block saves from an opened world sit under their own root in
// the tree instead of merging into the vanilla namespaces
let worldNames = []

function refreshNames() {
  state.names = Array.from(structPath.keys()).concat(Object.keys(GENERATED), worldNames).sort()
  if (state.selected.length) state.selected = state.selected.filter(rel => has(rel))
}

function setWorldStructures(names) {
  worldNames = names
  refreshNames()
}

async function populate() {
  const lib = await loadLibrary()
  structPath = new Map()
  // lowest priority first so a higher pack's zip path wins the map slot
  for (const src of Array.from(packs.allSources()).reverse()) {
    for (const k of lib.parseZip(src).keys()) {
      const m = k.match(STRUCT_RE)
      if (m) structPath.set(m[1] + "/" + m[2], k)
    }
  }
  refreshNames()
}

async function allZipKeys() {
  const lib = await loadLibrary()
  const keys = new Set()
  for (const src of packs.allSources()) for (const k of lib.parseZip(src).keys()) keys.add(k)
  return keys
}

// One lazy pass over every namespace's worldgen data:
// - starterSet: structures that start a build (a structure is a piece if a
//   non-start template pool lists it; everything else is a starter)
// - standaloneSet: starters that also load nothing else in (not a start-pool
//   member, not a procedural entry); entity spawns don't count
// - structDepth: each start-pool member's generation depth (the structure
//   def's `size`), the "fully loaded" point when growing jigsaws
function computeWorldgen() {
  worldgenPromise ??= (async () => {
    const lib = await loadLibrary()
    const assets = packs.assets.value
    if (!assets) return
    const td = new TextDecoder()
    async function readJson(p) {
      try { const b = await lib.readFile(p, assets); return b ? JSON.parse(td.decode(b)) : null } catch { return null }
    }
    const SR = /^data\/([^/]+)\/worldgen\/structure\/(.+)\.json$/
    const PR = /^data\/([^/]+)\/worldgen\/template_pool\/(.+)\.json$/
    const nsify = ref => typeof ref === "string" ? ref.replace(":", "/") : ref
    const keys = Array.from(await allZipKeys())
    const startPoolDepth = new Map(), startPoolRadius = new Map()
    for (const p of keys) {
      const m = p.match(SR); if (!m) continue
      const j = await readJson(p)
      if (typeof j?.start_pool === "string") {
        const sp = nsify(j.start_pool)
        // max_distance_from_center is a plain number or, in newer formats,
        // { horizontal, vertical }; 80 was the default when it was optional
        const md = j.max_distance_from_center
        const r = typeof md === "number" ? md : typeof md?.horizontal === "number" ? md.horizontal : 80
        startPoolDepth.set(sp, typeof j.size === "number" ? j.size : 7)
        startPoolRadius.set(sp, r)
      }
    }
    const childRef = new Set(), startMembers = new Set(), depth = new Map(), radius = new Map()
    function locs(j) {
      const out = []
      for (const e of j?.elements || []) {
        const el = e.element || {}
        if (typeof el.location === "string") out.push(nsify(el.location))
        for (const le of el.elements || []) if (typeof le?.location === "string") out.push(nsify(le.location))
      }
      return out
    }
    for (const p of keys) {
      const m = p.match(PR); if (!m) continue
      const name = m[1] + "/" + m[2], j = await readJson(p)
      if (startPoolDepth.has(name)) {
        for (const l of locs(j)) {
          depth.set(l, startPoolDepth.get(name))
          radius.set(l, startPoolRadius.get(name))
          startMembers.add(l)
        }
      } else {
        for (const l of locs(j)) childRef.add(l)
      }
    }
    starterSet = new Set(state.names.filter(n => !childRef.has(n)))
    // a proc prefix matches on path boundaries, so an entry name that is a
    // prefix of a sibling's (end/spike vs end/spike_caged) can't hide it
    for (const p of PROC) {
      const pref = p.prefix.endsWith("/") ? p.prefix : p.prefix + "/"
      for (const n of state.names) if (n !== p.entry && (n === p.prefix || n.startsWith(pref))) starterSet.delete(n)
    }
    const procEntry = new Set(PROC.map(p => p.entry))
    standaloneSet = new Set(Array.from(starterSet).filter(n => !startMembers.has(n) && !procEntry.has(n)))
    structDepth = depth
    structRadius = radius
    state.worldgenReady = true
  })()
  return worldgenPromise
}

async function refresh() {
  state.indexing = true
  try {
    worldgenPromise = null
    starterSet = standaloneSet = structDepth = structRadius = null
    state.worldgenReady = false
    await populate()
    if (state.filterMode !== "all") await computeWorldgen()
  } finally {
    state.indexing = false
  }
}

watch(() => packs.state.assetsVersion, refresh)

function filteredNames() {
  const set = state.filterMode === "starters" ? starterSet : state.filterMode === "standalone" ? standaloneSet : null
  return set ? state.names.filter(n => set.has(n)) : state.names
}

// what the sidebar list is currently showing (filter mode + search text)
function visibleNames() {
  let names = filteredNames()
  const q = state.filterText.trim().toLowerCase()
  if (q) names = names.filter(n => n.toLowerCase().includes(q))
  return names
}

const zipPathOf = name => structPath.get(name)
const has = name => structPath.has(name) || name in GENERATED || worldNames.includes(name)
const getStructDepth = name => structDepth?.get(name)
const getStructRadius = name => structRadius?.get(name)

export function useStructures() {
  return { state: readonly(state), stateMut: state, refresh, computeWorldgen, filteredNames, visibleNames, zipPathOf, has, getStructDepth, getStructRadius, setWorldStructures }
}
