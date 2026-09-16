import fs from "node:fs"
import { readZip } from "minecraft-asset-loader"
import { read } from "minecraft-block-reader"
import { normStatesDeep } from "../../src/transforms.js"
import { inlineProviders } from "../../src/features/providers.js"

export async function featureFilesFromZip(zipPath) {
  const files = new Map()
  for (const e of readZip(fs.readFileSync(zipPath))) files.set(e.path, Buffer.from(await e.read()))
  return files
}

export async function buildGenCtx(files, clientJarPath) {
  const FEATURE_RE = /^data\/([^/]+)\/worldgen\/feature\/(.+)\.json$/
  const featureByRel = new Map()
  for (const [rel, bytes] of files) {
    const m = rel.match(FEATURE_RE)
    if (m) featureByRel.set(m[1] + "/" + m[2], normStatesDeep(JSON.parse(bytes.toString())))
  }
  const placedByRel = new Map()
  let clientZip = null
  if (fs.existsSync(clientJarPath)) {
    clientZip = new Map(readZip(fs.readFileSync(clientJarPath)).map(e => [e.path, e]))
    for (const [entry, e] of clientZip) {
      const m = entry.match(/^data\/([^/]+)\/worldgen\/placed_feature\/(.+)\.json$/)
      if (m) placedByRel.set(m[1] + "/" + m[2], normStatesDeep(JSON.parse(Buffer.from(await e.read()).toString())))
    }
  }
  const nsPath = ref => ref.includes(":") ? ref.replace(":", "/") : "minecraft/" + ref
  const readProvider = async id => {
    const key = `data/${nsPath(id).replace("/", "/worldgen/block_state_provider/")}.json`
    const bytes = files.get(key) ?? (clientZip?.has(key) ? Buffer.from(await clientZip.get(key).read()) : null)
    return bytes ? normStatesDeep(JSON.parse(bytes.toString())) : null
  }
  for (const map of [featureByRel, placedByRel]) for (const json of map.values()) await inlineProviders(json, readProvider)
  const loadStruct = async ref => {
    const e = clientZip?.get("data/" + nsPath(ref).replace(/^([^/]+)\//, "$1/structure/") + ".nbt")
    return e ? read(Buffer.from(await e.read())) : null
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
  const loadProcessors = async ref => {
    const rel = ref.includes(":") ? ref.replace(":", "/") : "minecraft/" + ref
    const [ns, ...rest] = rel.split("/")
    const key = `data/${ns}/worldgen/processor_list/${rest.join("/")}.json`
    const bytes = files.get(key) ?? (clientZip?.has(key) ? Buffer.from(await clientZip.get(key).read()) : null)
    if (!bytes) return []
    try { return normStatesDeep(JSON.parse(bytes.toString()))?.processors ?? [] } catch { return [] }
  }
  return { featureByRel, placedByRel, resolvePlaced, loadStruct, loadProcessors }
}
