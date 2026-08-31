// a zip that is not a world, resource pack or data pack is read as a plain
// folder, and every structure in it is listed under the `zip` namespace

const WORLD = /(^|\/)(level\.dat|session\.lock)$|(^|\/)(region|entities|poi|db)\/|(^|\/)DIM-?\d+\//i
const PACK = /(^|\/)(pack\.mcmeta|manifest\.json)$|(^|\/)(data|assets)\/[^/]+\//i

export const LOOSE_RE = /^(.+)\.(nbt|mcstructure|litematic|schem|schematic)$/i

// zips written on windows store backslashes
export const normZipKey = k => k.replace(/\\/g, "/")

export function isLooseZip(keys) {
  for (const k of keys) {
    const n = normZipKey(k)
    if (WORLD.test(n) || PACK.test(n)) return false
  }
  return true
}

export async function entryBytes(entry) {
  if (!entry) return null
  const data = entry.data
  if (!data) return null
  if (entry.method === 0) return data
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
