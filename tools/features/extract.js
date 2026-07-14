// Usage:  node tools/features/extract.js [version]
//   version defaults to the latest snapshot from Mojang's manifest.
//   Requires a JDK (javac/java on PATH or via JAVA_HOME).
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { javaBin, packBundle, prepareClient, prepareVersion, walk, writeBundle } from "../builtin/common.js"
import { buildGenCtx } from "./lib.js"
import { generateFeature } from "../../src/features/index.js"
import { rnd } from "../../src/transforms.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const cache = path.resolve(here, "../builtin/.cache")
const log = (...a) => console.log("[features]", ...a)

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith("--"))
  const { id, verDir, cp } = await prepareVersion(cache, positional[0], log)
  log("version:", id)

  const classesDir = path.join(verDir, "feature-classes")
  fs.rmSync(classesDir, { recursive: true, force: true })
  fs.mkdirSync(classesDir, { recursive: true })
  log("compiling FeatureExtract.java")
  execFileSync(javaBin("javac"), ["-cp", cp, "-nowarn", "-d", classesDir, path.join(here, "FeatureExtract.java")], { stdio: "inherit", cwd: verDir })

  const outDir = path.join(verDir, "features-out")
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  log("running extractor")
  execFileSync(javaBin("java"), ["-cp", `${cp}${path.delimiter}${classesDir}`, "FeatureExtract", outDir], { stdio: "inherit", cwd: verDir })

  const files = new Map()
  for (const rel of walk(outDir).sort()) files.set(rel, fs.readFileSync(path.join(outDir, rel)))
  for (const name of STRUCTURE_DUPES) {
    const key = `data/minecraft/worldgen/feature/${name}.json`
    if (files.has(key)) files.delete(key)
    else log(`note: structure dupe "${name}" no longer exists in this version, prune it from STRUCTURE_DUPES`)
  }
  const ctx = buildGenCtx(files, await prepareClient(verDir, id, log))

  // template stampers duplicate the structures tab; the scan follows
  // references, so wrappers go with the stamp they wrap
  const templateBased = []
  for (const [rel, json] of Array.from(ctx.featureByRel)) {
    if (await stampsTemplates(ctx, json, new Set())) {
      templateBased.push(rel)
      files.delete(`data/${rel.replace("/", "/worldgen/feature/")}.json`)
      ctx.featureByRel.delete(rel)
    }
  }

  log("sampling rolls (default seeds, statics, single-block detection)")
  const { defaults, statics, singles } = await sampleRolls(ctx)

  // ref-only selectors just pick between features the list already shows
  const selectors = []
  for (const [rel, json] of ctx.featureByRel) {
    const entries = selectorEntries(json)
    if (entries && entries.every(isRef)) selectors.push(rel)
  }
  selectors.sort()

  // singles and ref-only selectors are delisted; the unreferenced ones leave
  // the zip entirely (the viewer never indexes the jar, so gone is gone)
  const removed = removableFeatures(ctx, Array.from(new Set(singles.concat(selectors))))
  const removedSet = new Set(removed)
  for (const rel of removed) {
    files.delete(`data/${rel.replace("/", "/worldgen/feature/")}.json`)
    ctx.featureByRel.delete(rel)
    delete defaults[rel]
  }
  const singleSet = new Set(singles)
  for (const rel of singles) delete defaults[rel]
  // delist files ship only when they have names in them
  const keptSingles = singles.filter(rel => !removedSet.has(rel))
  const keptSelectors = selectors.filter(rel => !removedSet.has(rel))
  if (keptSingles.length) files.set("viewer/hidden_features.json", Buffer.from(JSON.stringify(keptSingles, null, 2)))
  if (keptSelectors.length) files.set("viewer/redundant_selectors.json", Buffer.from(JSON.stringify(keptSelectors, null, 2)))
  // a tools-side record only: the viewer no longer reads it
  const dupes = STRUCTURE_DUPES.map(n => "minecraft/" + n).concat(templateBased).sort()
  files.set("viewer/structure_dupes.json", Buffer.from(JSON.stringify(dupes, null, 2)))

  files.set("viewer/default_seeds.json", Buffer.from(JSON.stringify(defaults, null, 2)))
  files.set("viewer/static_features.json", Buffer.from(JSON.stringify(statics.filter(rel => !singleSet.has(rel) && !removedSet.has(rel)), null, 2)))

  const root = path.resolve(here, "../..")
  writeBundle(path.join(root, "bundled/features"), files)
  packBundle(path.join(root, "bundled/features"), path.join(root, "public/features.zip"))
  log(`wrote bundled/features + public/features.zip: ${ctx.featureByRel.size} features, ${singles.length} single-block + ${selectors.length} ref-only selectors delisted (${removed.length} unreferenced, removed), ${templateBased.length} template stampers excluded, ${statics.length} static`)
}

// already offered under Structures (extracted builtins)
const STRUCTURE_DUPES = [
  "bonus_chest",
  "desert_well",
  "monster_room",
  "end_gateway_delayed",
  "end_gateway_return",
  "end_platform",
  "end_spike",
  "end_podium_active",
  "end_podium_inactive",
  "void_start_platform"
]

const isRef = x => typeof x === "string" || (x != null && typeof x === "object" && x.feature !== undefined && isRef(x.feature))

// fossils also stamp templates but their overlay processors do real
// generation, so anything beyond a pure stamp stays a feature
async function stampsTemplates(ctx, json, seen) {
  if (json == null) return false
  if (typeof json === "string") {
    if (seen.has(json)) return false
    seen.add(json)
    const inner = await ctx.resolvePlaced(json)
    return inner && typeof inner === "object" ? stampsTemplates(ctx, inner, seen) : false
  }
  if (typeof json !== "object") return false
  if (!Array.isArray(json) && /^(minecraft:)?template$/.test(json.type ?? "")) return true
  for (const v of Object.values(json)) if (await stampsTemplates(ctx, v, seen)) return true
  return false
}

function selectorEntries(json) {
  switch ((json.type ?? "").replace("minecraft:", "")) {
    case "random_selector": return (json.features ?? []).map(f => f.feature ?? f).concat([json.default])
    case "weighted_random_selector": return (json.features ?? json.distribution ?? []).map(e => e.data)
    case "simple_random_selector": return json.features ?? []
    case "random_boolean_selector": return [json.feature_true, json.feature_false]
  }
  return null
}

// seed 0 often rolls tiny, so the default load gets the median-size roll of a sampled batch
const DEFAULT_SAMPLES = 256

// handpicked seeds beat the computed median: good-looking over statistically average
const HANDPICKED_SEEDS = {
  "minecraft/amethyst_geode": 2948352934
}

function shapeKey(s) {
  return s.blocks.map(b => {
    const e = s.palette[b.state]
    return `${b.pos[0] - s.anchor[0]},${b.pos[1]},${b.pos[2] - s.anchor[2]}|${e.Name}|${e.Properties ? JSON.stringify(e.Properties) : ""}`
  }).sort().join("\n")
}

// a two-block double plant (lower+upper halves) counts as just-a-block too
function isDoublePlant(s) {
  if (s.blocks.length !== 2) return false
  const [a, b] = s.blocks.map(x => s.palette[x.state])
  if (a.Name !== b.Name) return false
  const halves = new Set([a.Properties?.half, b.Properties?.half])
  return halves.has("lower") && halves.has("upper")
}

async function sampleRolls(ctx) {
  const defaults = {}
  const statics = []
  const singles = []
  for (const [rel, seed] of Object.entries(HANDPICKED_SEEDS)) {
    if (ctx.featureByRel.has(rel)) defaults[rel] = seed
    else log(`note: handpicked seed for "${rel}" points at a feature that no longer exists`)
  }
  for (const [rel, json] of ctx.featureByRel) {
    try {
      const rolls = []
      let firstKey = null, allSame = true, allSingle = true
      for (let seed = 0; seed < DEFAULT_SAMPLES; seed++) {
        const s = await generateFeature(rel, json, rnd(seed), ctx.resolvePlaced, ctx.loadStruct)
        rolls.push({ seed, n: s.blocks.length })
        if (allSingle && s.blocks.length > 1 && !isDoublePlant(s)) allSingle = false
        if (allSame) {
          const key = shapeKey(s)
          if (firstKey === null) firstKey = key
          else if (key !== firstKey) allSame = false
        }
      }
      if (allSingle) singles.push(rel)
      if (allSame) statics.push(rel)
      if (defaults[rel] !== undefined) continue
      rolls.sort((a, b) => a.n - b.n || a.seed - b.seed)
      const mid = rolls[Math.floor(rolls.length / 2)]
      if (mid.seed !== 0) defaults[rel] = mid.seed
    } catch {}
  }
  return { defaults, statics: statics.sort(), singles: singles.sort() }
}

const nsPath = ref => ref.includes(":") ? ref.replace(":", "/") : "minecraft/" + ref

// every string anywhere in a config that resolves as a feature (directly or
// through the placed registry) counts as a reference: over-detection only
// keeps a removable file, under-detection would break resolution
function collectRefs(ctx, json, out, seenPlaced) {
  if (typeof json === "string") {
    const rel = nsPath(json)
    if (ctx.featureByRel.has(rel)) out.add(rel)
    const placed = ctx.placedByRel.get(rel)
    // ids collide across registries, so a placed chain can name itself: guard it
    if (placed && !seenPlaced.has(rel)) {
      seenPlaced.add(rel)
      collectRefs(ctx, placed.feature, out, seenPlaced)
    }
    return
  }
  if (Array.isArray(json)) {
    for (const v of json) collectRefs(ctx, v, out, seenPlaced)
    return
  }
  if (json !== null && typeof json === "object") {
    for (const v of Object.values(json)) collectRefs(ctx, v, out, seenPlaced)
  }
}

// delist candidates nothing resolves through, transitively from the features
// that stay listed (a chain of candidates only referencing each other drops whole)
function removableFeatures(ctx, candidates) {
  const refsOf = new Map()
  for (const [rel, json] of ctx.featureByRel) {
    const out = new Set()
    collectRefs(ctx, json, out, new Set())
    out.delete(rel)
    refsOf.set(rel, out)
  }
  const candidateSet = new Set(candidates)
  const keep = new Set()
  const queue = []
  for (const rel of ctx.featureByRel.keys()) {
    if (!candidateSet.has(rel)) {
      keep.add(rel)
      queue.push(rel)
    }
  }
  while (queue.length) {
    for (const t of refsOf.get(queue.pop()) ?? []) {
      if (!keep.has(t)) {
        keep.add(t)
        queue.push(t)
      }
    }
  }
  return candidates.filter(rel => !keep.has(rel)).sort()
}

main().catch(e => { console.error(e); process.exit(1) })
