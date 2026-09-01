// a datapack in a save is either a folder or a zip of its own, and both hold
// their structures at data/<namespace>/structure/<path>.nbt
import { normZipKey } from "./loosezip.js"

const DP_STRUCT = /^data\/([^/]+)\/structures?\/(.+)\.nbt$/

export async function datapackStructures(paths, { readFile, parseZip }) {
  const out = []
  const zips = []
  for (const sub of paths) {
    const folder = sub.match(/^([^/]+)\/(data\/[^/]+\/structures?\/.+\.nbt)$/)
    if (folder) {
      const m = folder[2].match(DP_STRUCT)
      if (m) out.push({ group: folder[1], ns: m[1], path: m[2], file: "datapacks/" + sub })
      continue
    }
    if (/^[^/]+\.zip$/i.test(sub)) zips.push(sub)
  }
  for (const sub of zips) {
    try {
      const bytes = await readFile("datapacks/" + sub)
      if (!bytes) continue
      const zip = parseZip(bytes)
      const group = sub.replace(/\.zip$/i, "")
      for (const k of zip.keys()) {
        const m = normZipKey(k).match(DP_STRUCT)
        if (m) out.push({ group, ns: m[1], path: m[2], entry: zip.get(k) })
      }
    } catch {}
  }
  return out
}
