import { reactive, readonly, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { numeric } from "../transforms.js"

const FEATURE_RE = /^data\/([^/]+)\/worldgen\/feature\/(.+)\.json$/

const packs = usePacks()
const textDecoder = new TextDecoder()

const state = reactive({
  names: [],
  filterText: "",
  selected: [],
  indexing: false
})

let featurePath = new Map()
let defaultSeeds = {}
let staticSet = new Set()
let folders = {}
let biomes = {}

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

async function refresh() {
  state.indexing = true
  try {
    await populate()
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
    if (ref.feature !== undefined) return resolveFeatureRef(ref.feature)
    return ref
  }
  const rel = nsPath(ref)
  const placed = await readJson(`data/${rel.replace("/", "/worldgen/placed_feature/")}.json`)
  if (placed?.feature !== undefined) return resolveFeatureRef(placed.feature)
  return readFeature(rel)
}

async function resolveFeatureRef(ref) {
  if (ref == null) return null
  if (typeof ref === "object") return ref.feature !== undefined ? resolveFeatureRef(ref.feature) : ref
  return readFeature(nsPath(ref))
}

function visibleNames() {
  const q = state.filterText.trim().toLowerCase()
  return q ? state.names.filter(n => n.toLowerCase().includes(q)) : state.names
}

const defaultSeed = rel => defaultSeeds[rel] ?? 0
const isStatic = rel => staticSet.has(rel)
const has = rel => featurePath.has(rel)
const folderOf = rel => folders[rel] ?? ""
const grassBiome = rel => biomes[rel] ?? null

export function useFeatures() {
  return { state: readonly(state), stateMut: state, refresh, readFeature, resolvePlaced, visibleNames, defaultSeed, isStatic, has, folderOf, grassBiome }
}
