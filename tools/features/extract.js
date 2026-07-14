// Dumps the game's worldgen/feature registry to JSON and bundles it as
// public/features.zip, plus two precomputed viewer indexes: a just-a-block
// hide list and the ref-only selectors the viewer delists. Shares
// tools/builtin's version cache (server jar + extracted classpath) so both
// extractors download the game once.
//
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

  const hidden = await computeHidden(ctx)
  files.set("viewer/hidden_features.json", Buffer.from(JSON.stringify(hidden, null, 2)))

  // selectors that only pick between other registry features are redundant
  // in a list that already shows every feature; they stay in the zip (other
  // features resolve through them) but the viewer drops them from the list
  const selectors = []
  for (const [rel, json] of ctx.featureByRel) {
    const entries = selectorEntries(json)
    if (entries && entries.every(isRef)) selectors.push(rel)
  }
  files.set("viewer/redundant_selectors.json", Buffer.from(JSON.stringify(selectors.sort(), null, 2)))
  // snapshot jars ship worldgen/feature JSONs as data, so deleting the dupes
  // from this zip isn't enough: the viewer also delists them by name
  files.set("viewer/structure_dupes.json", Buffer.from(JSON.stringify(STRUCTURE_DUPES.map(n => "minecraft/" + n), null, 2)))

  log("picking default seeds (median-size roll per feature)")
  const { defaults, statics } = await computeDefaults(ctx)
  files.set("viewer/default_seeds.json", Buffer.from(JSON.stringify(defaults)))
  files.set("viewer/static_features.json", Buffer.from(JSON.stringify(statics, null, 2)))

  const root = path.resolve(here, "../..")
  writeBundle(path.join(root, "bundled/features"), files)
  packBundle(path.join(root, "bundled/features"), path.join(root, "public/features.zip"))
  log(`wrote bundled/features + public/features.zip: ${ctx.featureByRel.size} features, ${hidden.length} hidden as just-a-block, ${selectors.length} ref-only selectors delisted, ${statics.length} static`)
}

// the viewer already offers these under Structures (extracted builtins), so
// they don't get a second entry in the Features tab
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

// a selector entry is a pure reference when it bottoms out in a registry id
// rather than an inline feature config
const isRef = x => typeof x === "string" || (x != null && typeof x === "object" && x.feature !== undefined && isRef(x.feature))

function selectorEntries(json) {
  switch ((json.type ?? "").replace("minecraft:", "")) {
    case "random_selector": return (json.features ?? []).map(f => f.feature ?? f).concat([json.default])
    case "weighted_random_selector": return (json.features ?? json.distribution ?? []).map(e => e.data)
    case "simple_random_selector": return json.features ?? []
    case "random_boolean_selector": return [json.feature_true, json.feature_false]
  }
  return null
}

// Seed 0 often rolls a tiny output, so the default (clean-url) load uses a
// representative seed instead: sample a batch per feature, sort by block
// count, take the seed in the middle of the range. Explicit ?fseed and
// Re-roll are unaffected.
const DEFAULT_SAMPLES = 256

// hand-picked defaults win over the computed median: a good-looking roll
// beats a statistically average one
const HANDPICKED_SEEDS = {
  "minecraft/amethyst_geode": 2948352934
}

// canonical shape key, used to spot features whose output never varies
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

// Precompute the names whose seed-0 roll is just a block (one cell, or the
// upper and lower halves of one double plant): the viewer hides those from
// its list instead of re-deriving this on every load
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
