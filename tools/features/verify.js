// Usage:  node tools/features/verify.js [version]
//   version picks the cached client.jar; downloads through the shared cache when missing.
import path from "node:path"
import { fileURLToPath } from "node:url"
import { prepareVersion } from "../builtin/common.js"
import { buildGenCtx, featureFilesFromZip } from "./lib.js"
import { generateFeature } from "../../src/features/index.js"
import { rnd } from "../../src/transforms.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const cache = path.resolve(here, "../builtin/.cache")
const log = (...a) => console.log("[verify]", ...a)

const positional = process.argv.slice(2).filter(a => !a.startsWith("--"))
const { id, verDir } = await prepareVersion(cache, positional[0], log)
log("version:", id)

const files = featureFilesFromZip(path.resolve(here, "../../public/features.zip"))
const ctx = buildGenCtx(files, path.join(verDir, "client.jar"))

const failures = new Map()
let ok = 0, empty = 0
for (const [rel, json] of ctx.featureByRel) {
  for (const seed of [0, 3]) {
    try {
      const s = await generateFeature(rel, json, rnd(seed), ctx.resolvePlaced, ctx.loadStruct)
      if (!s.blocks.length) { if (seed === 0) { empty++; console.log("EMPTY  ", rel, json.type) } }
      else if (seed === 0) ok++
    } catch (e) {
      const key = json.type + " :: " + (e.message ?? e)
      if (!failures.has(key)) failures.set(key, [])
      failures.get(key).push(rel + "@" + seed)
      break
    }
  }
}
log(`ok: ${ok}  empty: ${empty}  failing groups: ${failures.size}`)
for (const [k, rels] of failures) {
  console.log("FAIL", k, "->", rels.slice(0, 4).join(", "), rels.length > 4 ? `(+${rels.length - 4})` : "")
}
process.exit(failures.size || empty ? 1 : 0)
