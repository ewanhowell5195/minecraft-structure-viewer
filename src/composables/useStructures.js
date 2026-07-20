import { reactive, readonly, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { PROC } from "../proc.js"
import { GENERATED } from "../generators/builtin.js"
import { numeric, strip } from "../transforms.js"
import { readStructure } from "../nbt.js"
import { lootTableItems, readTrialSpawnerConfig } from "../loot.js"
import { matchIndex } from "../advfilter.js"
import { buildProcessorIndex } from "../processors.js"
import { yieldTask } from "../yield.js"

// structures? also matches the legacy/mod plural folder
const STRUCT_RE = /^data\/([^/]+)\/structures?\/(.+)\.nbt$/

const packs = usePacks()

const state = reactive({
  names: [],
  filterText: "",
  filterMode: "all",
  advQuery: "",
  selected: [],
  indexing: false,
  worldgenReady: false,
  advReady: false
})

let structPath = new Map()
let starterSet = null, standaloneSet = null, structDepth = null, structRadius = null
let worldgenPromise = null
let blockIndex = null, itemIndex = null, entityIndex = null
let blockVocab = [], itemVocab = [], entityVocab = [], advPromise = null

let worldNames = []
let procIndex = null, procPromise = null

function computeProcessors() {
  procPromise ??= (async () => {
    const lib = await loadLibrary()
    const assets = packs.assets.value
    if (!assets) return
    const td = new TextDecoder()
    const readJson = async p => {
      try { const b = await lib.readFile(p, assets); return b ? JSON.parse(td.decode(b)) : null } catch { return null }
    }
    procIndex = await buildProcessorIndex(Array.from(await allZipKeys()), readJson, Array.from(structPath.keys()))
  })()
  return procPromise
}

const processorEntry = rel => procIndex?.get(rel)

function refreshNames() {
  state.names = Array.from(structPath.keys()).concat(Object.keys(GENERATED)).sort(numeric)
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

// starterSet: not listed as a piece by any non-start pool; standaloneSet:
// starters that pull nothing else in (entity spawns don't count)
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
        // 80 was max_distance_from_center's default when it was optional
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
    // string prefix of a sibling's can't hide it
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

// item stacks stored directly in a container block entity (chests are usually
// LootTable-driven, but pre-filled Items and the container component both occur)
function collectContainerItems(nbt, out) {
  const items = nbt?.Items ?? nbt?.components?.["minecraft:container"]
  if (!Array.isArray(items)) return
  for (const slot of items) {
    const stack = slot?.item ?? slot
    if (typeof stack?.id === "string") out.add(strip(stack.id))
    const nested = stack?.tag?.BlockEntityTag ?? { components: stack?.components }
    if (nested) collectContainerItems(nested, out)
  }
}

const SPAWNER_RE = /(^|[:_])spawner$/

// entities a spawner block will produce, from its inline data or its (possibly
// file-referenced) trial spawner config
async function collectSpawnerEntities(nbt, out, trialCache) {
  const push = id => { if (typeof id === "string") out.add(strip(id)) }
  push(nbt.SpawnData?.entity?.id)
  for (const sp of nbt.SpawnPotentials ?? []) push(sp?.data?.entity?.id)
  for (const ref of [nbt.normal_config, nbt.ominous_config]) {
    if (ref == null) continue
    let cfg
    if (typeof ref === "string") {
      if (!trialCache.has(ref)) trialCache.set(ref, await readTrialSpawnerConfig(ref))
      cfg = trialCache.get(ref)
    } else cfg = await readTrialSpawnerConfig(ref)
    for (const sp of cfg?.spawn_potentials ?? []) push(sp?.data?.entity?.id)
  }
}

// scan every structure once, building block/item/entity -> structures inverted
// indexes; cached until the assets change (see refresh)
async function computeAdvIndex() {
  advPromise ??= (async () => {
    const lib = await loadLibrary()
    const assets = packs.assets.value
    if (!assets) return
    const bIdx = new Map(), iIdx = new Map(), eIdx = new Map()
    const trialCache = new Map()
    const add = (map, key, name) => {
      let set = map.get(key)
      if (!set) map.set(key, set = new Set())
      set.add(name)
    }
    let n = 0
    for (const [name, zp] of structPath) {
      if (++n % 20 === 0) await yieldTask()
      let s
      try { s = await readStructure(await lib.readFile(zp, assets)) } catch { continue }
      for (const e of s.palette) if (e?.Name) add(bIdx, strip(e.Name), name)
      for (const e of s.entities) if (typeof e.nbt?.id === "string") add(eIdx, strip(e.nbt.id), name)
      for (const b of s.blocks) {
        if (!b.nbt) continue
        const items = new Set()
        collectContainerItems(b.nbt, items)
        if (typeof b.nbt.LootTable === "string") await lootTableItems(b.nbt.LootTable, items)
        for (const id of items) add(iIdx, id, name)
        if (SPAWNER_RE.test(s.palette[b.state]?.Name ?? "")) {
          const ents = new Set()
          await collectSpawnerEntities(b.nbt, ents, trialCache)
          for (const id of ents) add(eIdx, id, name)
        }
      }
    }
    blockIndex = bIdx
    itemIndex = iIdx
    entityIndex = eIdx
    blockVocab = Array.from(bIdx.keys()).sort()
    itemVocab = Array.from(iIdx.keys()).sort()
    entityVocab = Array.from(eIdx.keys()).sort()
    state.advReady = true
  })()
  return advPromise
}

async function refresh() {
  state.indexing = true
  try {
    worldgenPromise = null
    starterSet = standaloneSet = structDepth = structRadius = null
    advPromise = null
    procPromise = null
    procIndex = null
    blockIndex = itemIndex = entityIndex = null
    blockVocab = itemVocab = entityVocab = []
    state.worldgenReady = false
    state.advReady = false
    await populate()
    if (state.filterMode === "starters" || state.filterMode === "standalone") await computeWorldgen()
    if (ADV_MODES.has(state.filterMode)) await computeAdvIndex()
  } finally {
    state.indexing = false
  }
}

watch(() => packs.state.assetsVersion, refresh)

const ADV_MODES = new Set(["block", "item", "entity"])
const advIndexFor = mode => mode === "item" ? itemIndex : mode === "entity" ? entityIndex : blockIndex

function filteredNames() {
  if (ADV_MODES.has(state.filterMode)) {
    const hit = matchIndex(advIndexFor(state.filterMode), state.advQuery)
    return hit ? state.names.filter(n => hit.has(n)) : state.names
  }
  const set = state.filterMode === "starters" ? starterSet : state.filterMode === "standalone" ? standaloneSet : null
  return set ? state.names.filter(n => set.has(n)) : state.names
}

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

const advVocab = () => state.filterMode === "item" ? itemVocab : state.filterMode === "entity" ? entityVocab : blockVocab

export function useStructures() {
  return { state: readonly(state), stateMut: state, refresh, computeWorldgen, computeAdvIndex, computeProcessors, processorEntry, advVocab, filteredNames, visibleNames, zipPathOf, has, getStructDepth, getStructRadius, setWorldStructures }
}
