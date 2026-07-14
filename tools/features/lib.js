import fs from "node:fs"
import { readZip, unzipEntry } from "../builtin/zip.js"
import { readStructure } from "../../src/nbt.js"

export function featureFilesFromZip(zipPath) {
  const files = new Map()
  for (const [k, e] of readZip(fs.readFileSync(zipPath))) {
    files.set(k, Buffer.from(unzipEntry(e)))
  }
  return files
}

export function buildGenCtx(files, clientJarPath) {
  const FEATURE_RE = /^data\/([^/]+)\/worldgen\/feature\/(.+)\.json$/
  const featureByRel = new Map()
  for (const [rel, bytes] of files) {
    const m = rel.match(FEATURE_RE)
    if (m) featureByRel.set(m[1] + "/" + m[2], JSON.parse(bytes.toString()))
  }
  const placedByRel = new Map()
  let clientZip = null
  if (fs.existsSync(clientJarPath)) {
    clientZip = readZip(fs.readFileSync(clientJarPath))
    for (const [entry, e] of clientZip) {
      const m = entry.match(/^data\/([^/]+)\/worldgen\/placed_feature\/(.+)\.json$/)
      if (m) placedByRel.set(m[1] + "/" + m[2], JSON.parse(Buffer.from(unzipEntry(e)).toString()))
    }
  }
  const nsPath = ref => ref.includes(":") ? ref.replace(":", "/") : "minecraft/" + ref
  const loadStruct = async ref => {
    const e = clientZip?.get("data/" + nsPath(ref).replace(/^([^/]+)\//, "$1/structure/") + ".nbt")
    return e ? readStructure(Buffer.from(unzipEntry(e))) : null
  }
  // a placed feature's inner ref points at the FEATURE registry, never back
  // through placed: ids collide across the two registries
  const resolveFeatureRef = ref => ref == null ? null
    : typeof ref === "object" ? (ref.feature !== undefined ? resolveFeatureRef(ref.feature) : ref)
    : featureByRel.get(nsPath(ref)) ?? null
  const resolvePlaced = async ref => {
    if (ref == null) return null
    if (typeof ref === "object") return ref.feature !== undefined ? resolveFeatureRef(ref.feature) : ref
    const placed = placedByRel.get(nsPath(ref))
    if (placed?.feature !== undefined) return resolveFeatureRef(placed.feature)
    return featureByRel.get(nsPath(ref)) ?? null
  }
  return { featureByRel, resolvePlaced, loadStruct }
}
