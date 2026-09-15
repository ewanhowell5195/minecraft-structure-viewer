// Usage:  node tools/features/info.js [version]
//   categorisation aid for folders.json: prints every listed feature with its
//   config type, generation steps, and the biomes whose placed features reach
//   it (traversing placed refs and selector chains in the jar)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readZip } from "minecraft-asset-loader"
import { prepareClient, prepareVersion } from "../builtin/common.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const cache = path.resolve(here, "../builtin/.cache")
const log = (...a) => console.log("[info]", ...a)

const STEPS = ["raw_generation", "lakes", "local_modifications", "underground_structures", "surface_structures",
  "strongholds", "underground_ores", "underground_decoration", "fluid_springs", "vegetal_decoration", "top_layer_modification"]

const positional = process.argv.slice(2).filter(a => !a.startsWith("--"))
const { id, verDir } = await prepareVersion(cache, positional[0], log)
const td = new TextDecoder()
const json = async e => JSON.parse(td.decode(await e.read()))

// full jar registries: removed features still traverse here
const jarFeatures = new Map(), placed = new Map(), biomes = new Map()
for (const e of readZip(fs.readFileSync(await prepareClient(verDir, id, log)))) {
  let m
  if ((m = e.path.match(/^data\/minecraft\/worldgen\/feature\/(.+)\.json$/))) jarFeatures.set("minecraft/" + m[1], await json(e))
  else if ((m = e.path.match(/^data\/minecraft\/worldgen\/placed_feature\/(.+)\.json$/))) placed.set("minecraft/" + m[1], await json(e))
  else if ((m = e.path.match(/^data\/minecraft\/worldgen\/biome\/(.+)\.json$/))) biomes.set(m[1], await json(e))
}

// listed = the shipped zip minus the hidden names
const listed = new Map()
let hidden = []
for (const e of readZip(fs.readFileSync(path.resolve(here, "../../public/features.zip")))) {
  const m = e.path.match(/^data\/minecraft\/worldgen\/feature\/(.+)\.json$/)
  if (m) listed.set("minecraft/" + m[1], await json(e))
  if (e.path === "viewer/hidden_features.json") hidden = await json(e)
}
for (const rel of hidden) listed.delete(rel)

const nsPath = r => r.includes(":") ? r.replace(":", "/") : "minecraft/" + r

function reach(j, out, seen) {
  if (typeof j === "string") {
    const rel = nsPath(j)
    if (jarFeatures.has(rel) && !seen.has("f:" + rel)) {
      seen.add("f:" + rel)
      out.add(rel)
      reach(jarFeatures.get(rel), out, seen)
    }
    const p = placed.get(rel)
    if (p && !seen.has("p:" + rel)) {
      seen.add("p:" + rel)
      reach(p.feature, out, seen)
    }
    return
  }
  if (Array.isArray(j)) {
    for (const v of j) reach(v, out, seen)
    return
  }
  if (j !== null && typeof j === "object") for (const v of Object.values(j)) reach(v, out, seen)
}

const info = new Map()
for (const [rel, j] of listed) info.set(rel, { type: (j.type ?? "").replace("minecraft:", ""), steps: new Set(), biomes: new Set() })

for (const [biome, bj] of biomes) {
  ;(bj.features ?? []).forEach((stepList, si) => {
    for (const pid of [stepList].flat()) {
      if (typeof pid !== "string") continue
      const out = new Set()
      reach(pid, out, new Set())
      for (const rel of out) {
        const i = info.get(rel)
        if (!i) continue
        i.steps.add(STEPS[si] ?? String(si))
        i.biomes.add(biome)
      }
    }
  })
}

const folders = JSON.parse(fs.readFileSync(path.join(here, "folders.json")))
const folderOf = {}
for (const [folder, names] of Object.entries(folders)) for (const n of names) folderOf["minecraft/" + n] = folder

for (const [rel, i] of [...info].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
  const b = [...i.biomes].sort()
  const bs = b.length > 4 ? b.slice(0, 4).join(",") + `(+${b.length - 4})` : b.join(",") || "-"
  console.log(
    rel.replace("minecraft/", "").padEnd(34),
    (folderOf[rel] ?? "UNFILED").padEnd(18),
    i.type.padEnd(24),
    ([...i.steps].join(",") || "-").padEnd(30),
    bs
  )
}
