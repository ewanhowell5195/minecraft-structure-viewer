const WORLD = /(^|\/)(level\.dat|session\.lock)$|(^|\/)(region|db)\/|(^|\/)DIM-?\d+\//i
const PACK = /(^|\/)(pack\.mcmeta|manifest\.json)$|(^|\/)(data|assets)\/[^/]+\//i
const PACK_TREE = /(^|\/)(data|assets)\/[^/]+\//i

export const LOOSE_RE = /^(.+)\.(nbt|mcstructure|litematic|schem|schematic)$/i

// zips written on windows store backslashes
export const normZipKey = k => k.replace(/\\/g, "/")

export function zipKind(keys) {
  let pack = false
  for (const k of keys) {
    const n = normZipKey(k)
    if (WORLD.test(n) && !PACK_TREE.test(n)) return "world"
    if (!pack && PACK.test(n)) pack = true
  }
  return pack ? "pack" : "loose"
}

export const isLooseZip = keys => zipKind(keys) === "loose"
