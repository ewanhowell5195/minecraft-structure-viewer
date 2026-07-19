import { reactive, readonly, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { numeric, strip, rnd } from "../transforms.js"
import { matchIndex } from "../advfilter.js"
import { generateFeature } from "../features/index.js"
import { readStructure } from "../nbt.js"
import { useStructures } from "./useStructures.js"
import { yieldTask } from "../yield.js"

const FEATURE_RE = /^data\/([^/]+)\/worldgen\/feature\/(.+)\.json$/

const packs = usePacks()
const structures = useStructures()
const textDecoder = new TextDecoder()

const state = reactive({
  names: [],
  filterText: "",
  filterMode: "all",
  advQuery: "",
  selected: [],
  indexing: false,
  advReady: false
})

let featurePath = new Map()
let defaultSeeds = {}
let staticSet = new Set()
let folders = {}
let biomes = {}
let blockIndex = null, blockVocab = [], advPromise = null

async function populate() {
  const lib = await loadLibrary()
  featurePath = new Map()
  for (const src of Array.from(packs.featureSources()).reverse()) {
    for (const k of lib.parseZip(src).keys()) {
      const m = k.match(FEATURE_RE)
      if (m) featurePath.set(m[1] + "/" + m[2], k)
    }
  }
  // default seeds are tools/features' median-size picks (seed 0 often rolls
  // tiny); delisted selectors stay loadable so references still resolve
  const dbuf = await lib.readFile("viewer/default_seeds.json", packs.assets.value)
  defaultSeeds = dbuf ? JSON.parse(textDecoder.decode(dbuf)) : {}
  // features whose 256-seed sample never changed shape: no Re-roll, no Field
  const stbuf = await lib.readFile("viewer/static_features.json", packs.assets.value)
  staticSet = new Set(stbuf ? JSON.parse(textDecoder.decode(stbuf)) : [])
  // curated display folders (tools/features/folders.json); unmapped rels list at the root
  const fbuf = await lib.readFile("viewer/feature_folders.json", packs.assets.value)
  folders = fbuf ? JSON.parse(textDecoder.decode(fbuf)) : {}
  // per-tree home biome for the grass pad, in the lib's biome-arg shape
  const bbuf = await lib.readFile("viewer/feature_biomes.json", packs.assets.value)
  biomes = bbuf ? JSON.parse(textDecoder.decode(bbuf)) : {}
  // these names stay in the zip so references resolve; the list keeps them
  // out of the tree (fully removed features never index: no jar source)
  const delisted = new Set()
  for (const f of ["viewer/redundant_selectors.json", "viewer/hidden_features.json"]) {
    const buf = await lib.readFile(f, packs.assets.value)
    if (buf) for (const rel of JSON.parse(textDecoder.decode(buf))) delisted.add(rel)
  }
  state.names = Array.from(featurePath.keys()).filter(rel => !delisted.has(rel)).sort(numeric)
  if (state.selected.length) state.selected = state.selected.filter(rel => featurePath.has(rel))
}

// feature configs name blocks as BlockState objects ({ Name, Properties }) at
// varied depths (ore targets, tree trunk/foliage providers, flower lists...);
// a deep walk for Name values catches them all regardless of feature type
function collectBlockNames(node, out) {
  if (Array.isArray(node)) {
    for (const v of node) collectBlockNames(v, out)
  } else if (node && typeof node === "object") {
    if (typeof node.Name === "string") out.add(strip(node.Name))
    for (const v of Object.values(node)) collectBlockNames(v, out)
  }
}

const AIR = new Set(["air", "cave_air", "void_air", "structure_void"])

// fossil/template features stamp structure files into the world
async function loadStruct(ref) {
  const path = ref.includes(":") ? ref.replace(":", "/") : "minecraft/" + ref
  const zp = structures.zipPathOf(path)
  if (!zp) return null
  const lib = await loadLibrary()
  return readStructure(await lib.readFile(zp, packs.assets.value))
}

// scan every feature once, building block -> features; cached until assets
// change. the config walk covers every provider possibility; the default-seed
// roll (the same roll a click renders) adds what generation places beyond the
// config: hardcoded blocks, referenced features, stamped structures, and the
// grass/water pads trees and icebergs get
async function computeAdvIndex() {
  advPromise ??= (async () => {
    const idx = new Map()
    let n = 0
    for (const rel of state.names) {
      if (++n % 10 === 0) await yieldTask()
      let j
      try { j = await readFeature(rel) } catch { continue }
      if (!j) continue
      const names = new Set()
      collectBlockNames(j, names)
      try {
        const s = await generateFeature(rel, j, rnd(defaultSeed(rel)), resolvePlaced, loadStruct, {})
        for (const e of s.palette) if (typeof e?.Name === "string") names.add(strip(e.Name))
      } catch {}
      for (const b of names) {
        if (AIR.has(b)) continue
        let set = idx.get(b)
        if (!set) idx.set(b, set = new Set())
        set.add(rel)
      }
    }
    blockIndex = idx
    blockVocab = Array.from(idx.keys()).sort()
    state.advReady = true
  })()
  return advPromise
}

async function refresh() {
  state.indexing = true
  try {
    advPromise = null
    blockIndex = null
    blockVocab = []
    state.advReady = false
    await populate()
    if (state.filterMode === "block") await computeAdvIndex()
  } finally {
    state.indexing = false
  }
}

watch(() => packs.state.assetsVersion, refresh)

async function readJson(zipPath) {
  const lib = await loadLibrary()
  const buf = await lib.readFile(zipPath, packs.assets.value)
  return buf ? JSON.parse(textDecoder.decode(buf)) : null
}

async function readFeature(rel) {
  const zp = featurePath.get(rel)
  if (zp) return readJson(zp)
  const slash = rel.indexOf("/")
  return readJson(`data/${rel.slice(0, slash)}/worldgen/feature/${rel.slice(slash + 1)}.json`)
}

const nsPath = ref => ref.includes(":") ? ref.replace(":", "/") : "minecraft/" + ref

// a placed feature's inner ref targets the FEATURE registry; ids collide across
// registries (birch_bees_0002 is both), so the placed lookup would loop forever
async function resolvePlaced(ref) {
  if (ref == null) return null
  if (typeof ref === "object") {
    if (ref.type === undefined && ref.feature !== undefined) return resolveFeatureRef(ref.feature)
    return ref
  }
  const rel = nsPath(ref)
  const placed = await readJson(`data/${rel.replace("/", "/worldgen/placed_feature/")}.json`)
  if (placed?.feature !== undefined) return resolveFeatureRef(placed.feature)
  return readFeature(rel)
}

async function resolveFeatureRef(ref) {
  if (ref == null) return null
  if (typeof ref === "object") return ref.type === undefined && ref.feature !== undefined ? resolveFeatureRef(ref.feature) : ref
  return readFeature(nsPath(ref))
}

function filteredNames() {
  if (state.filterMode !== "block") return state.names
  const hit = matchIndex(blockIndex, state.advQuery)
  return hit ? state.names.filter(n => hit.has(n)) : state.names
}

function visibleNames() {
  const q = state.filterText.trim().toLowerCase()
  const base = filteredNames()
  return q ? base.filter(n => n.toLowerCase().includes(q)) : base
}

const defaultSeed = rel => defaultSeeds[rel] ?? 0
const isStatic = rel => staticSet.has(rel)
const has = rel => featurePath.has(rel)
const folderOf = rel => folders[rel] ?? ""
const grassBiome = rel => biomes[rel] ?? null

const advVocab = () => blockVocab

export function useFeatures() {
  return { state: readonly(state), stateMut: state, refresh, computeAdvIndex, advVocab, readFeature, resolvePlaced, filteredNames, visibleNames, defaultSeed, isStatic, has, folderOf, grassBiome }
}
