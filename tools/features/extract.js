// Usage:  node tools/features/extract.js [version]
//   version defaults to the latest snapshot from Mojang's manifest.
//   Requires a JDK (javac/java on PATH or via JAVA_HOME).
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { javaBin, packBundle, prepareVersion, walk, writeBundle } from "../builtin/common.js"
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
  const ctx = buildGenCtx(files, path.join(verDir, "client.jar"))

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

  const hidden = await computeHidden(ctx)
  files.set("viewer/hidden_features.json", Buffer.from(JSON.stringify(hidden, null, 2)))

  // ref-only selectors stay in the zip (other features resolve through them), the viewer just delists them
  const selectors = []
  for (const [rel, json] of ctx.featureByRel) {
    const entries = selectorEntries(json)
    if (entries && entries.every(isRef)) selectors.push(rel)
  }
  files.set("viewer/redundant_selectors.json", Buffer.from(JSON.stringify(selectors.sort(), null, 2)))
  // snapshot jars ship feature JSONs as data, so deleting dupes from this zip isn't enough: the viewer also delists by name
  const dupes = STRUCTURE_DUPES.map(n => "minecraft/" + n).concat(templateBased).sort()
  files.set("viewer/structure_dupes.json", Buffer.from(JSON.stringify(dupes, null, 2)))

  log("picking default seeds (median-size roll per feature)")
  const { defaults, statics } = await computeDefaults(ctx)
  files.set("viewer/default_seeds.json", Buffer.from(JSON.stringify(defaults, null, 2)))
  files.set("viewer/static_features.json", Buffer.from(JSON.stringify(statics, null, 2)))

  const root = path.resolve(here, "../..")
  writeBundle(path.join(root, "bundled/features"), files)
  packBundle(path.join(root, "bundled/features"), path.join(root, "public/features.zip"))
  log(`wrote bundled/features + public/features.zip: ${ctx.featureByRel.size} features, ${hidden.length} hidden as just-a-block, ${selectors.length} ref-only selectors delisted, ${templateBased.length} template stampers excluded, ${statics.length} static`)
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

async function computeDefaults(ctx) {
  const defaults = {}
  const statics = []
  for (const [rel, seed] of Object.entries(HANDPICKED_SEEDS)) {
    if (ctx.featureByRel.has(rel)) defaults[rel] = seed
    else log(`note: handpicked seed for "${rel}" points at a feature that no longer exists`)
  }
  for (const [rel, json] of ctx.featureByRel) {
    try {
      const rolls = []
      let firstKey = null, allSame = true
      for (let seed = 0; seed < DEFAULT_SAMPLES; seed++) {
        const s = await generateFeature(rel, json, rnd(seed), ctx.resolvePlaced, ctx.loadStruct)
        rolls.push({ seed, n: s.blocks.length })
        if (allSame) {
          const key = shapeKey(s)
          if (firstKey === null) firstKey = key
          else if (key !== firstKey) allSame = false
        }
      }
      if (allSame) statics.push(rel)
      if (defaults[rel] !== undefined) continue
      rolls.sort((a, b) => a.n - b.n || a.seed - b.seed)
      const mid = rolls[Math.floor(rolls.length / 2)]
      if (mid.seed !== 0) defaults[rel] = mid.seed
    } catch {}
  }
  return { defaults, statics: statics.sort() }
}

async function computeHidden(ctx) {
  const hidden = []
  for (const [rel, json] of ctx.featureByRel) {
    try {
      const s = await generateFeature(rel, json, rnd(0), ctx.resolvePlaced, ctx.loadStruct)
      const double = s.blocks.length === 2 && (() => {
        const [a, b] = s.blocks.map(x => s.palette[x.state])
        if (a.Name !== b.Name) return false
        const halves = new Set([a.Properties?.half, b.Properties?.half])
        return halves.has("lower") && halves.has("upper")
      })()
      if (s.blocks.length === 1 || double) hidden.push(rel)
    } catch {}
  }
  return hidden.sort()
}

main().catch(e => { console.error(e); process.exit(1) })
