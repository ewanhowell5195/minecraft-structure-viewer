const MODIFIERS = { dark_forest: c => ((c & 0xFEFEFE) + 0x28340A) >> 1, swamp: () => 0x4C763C }
const TYPES = ["grass", "foliage", "dry_foliage", "water"]
const WATER = 0x3F76E4
const BLEND = 2
const tables = new WeakMap()

export function colormapTypes(lib) {
  const types = new Map()
  for (const [type, ids] of Object.entries(lib.COLORS.colormap)) for (const id of ids) types.set(id, type)
  for (const id of ["water", "water_cauldron", "bubble_column"]) types.set(id, "water")
  return e => {
    const id = e.id.startsWith("minecraft:") ? e.id.slice(10) : e.id
    return types.get(id) ?? (lib.isWaterlogged(id) || (e.properties?.waterlogged === "true" && lib.isWaterloggable(id)) ? "water" : null)
  }
}

function table(assets) {
  let t = tables.get(assets)
  if (!t) tables.set(assets, t = { defs: new Map(), colors: new Map(), objects: new Map() })
  return t
}

function definition(lib, assets, t, id) {
  if (!t.defs.has(id)) {
    const [ns, path] = id.includes(":") ? id.split(":") : ["minecraft", id]
    t.defs.set(id, lib.readFile(`data/${ns}/worldgen/biome/${path}.json`, assets).then(buf => buf ? JSON.parse(new TextDecoder().decode(buf)) : null).catch(() => null))
  }
  return t.defs.get(id)
}

function colorOf(lib, assets, t, id, type) {
  const key = id + "\0" + type
  if (!t.colors.has(key)) {
    t.colors.set(key, definition(lib, assets, t, id).then(async d => {
      const fixed = d?.effects?.[type + "_color"]
      if (fixed !== undefined) return typeof fixed === "number" ? fixed : parseInt(String(fixed).replace("#", ""), 16)
      if (type === "water") return WATER
      if (!d) return null
      const c = parseInt((await lib.getBiomeTint(assets, type, { temperature: d.temperature ?? 0.5, downfall: d.downfall ?? 1 })).slice(1), 16)
      const modifier = type === "grass" ? MODIFIERS[d.effects?.grass_color_modifier] : null
      return modifier ? modifier(c) : c
    }))
  }
  return t.colors.get(key)
}

export function biomeWindow(biomeAt, x, y, z) {
  const own = biomeAt(x, y, z)
  if (!own) return null
  const counts = new Map()
  for (let dx = -BLEND; dx <= BLEND; dx++) {
    for (let dz = -BLEND; dz <= BLEND; dz++) {
      const id = biomeAt(x + dx, y, z + dz) ?? own
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return counts
}

export function countsKey(counts) {
  if (counts.size === 1) return counts.keys().next().value
  return Array.from(counts).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([id, n]) => id + ":" + n).join(",")
}

export async function biomeTints(lib, assets, ids) {
  const t = table(assets)
  const colors = new Map()
  for (const id of ids) for (const type of TYPES) colors.set(id + "\0" + type, await colorOf(lib, assets, t, id, type))
  const cache = new Map()
  return (counts, type) => {
    const key = type + "\0" + countsKey(counts)
    let tint = cache.get(key)
    if (tint !== undefined) return tint
    let r = 0, g = 0, b = 0, total = 0
    for (const [id, n] of counts) {
      const c = colors.get(id + "\0" + type)
      if (c == null) continue
      r += ((c >> 16) & 255) * n
      g += ((c >> 8) & 255) * n
      b += (c & 255) * n
      total += n
    }
    tint = null
    if (total) {
      const hex = "#" + ((Math.floor(r / total) << 16) | (Math.floor(g / total) << 8) | Math.floor(b / total)).toString(16).padStart(6, "0")
      tint = t.objects.get(type + hex)
      if (!tint) t.objects.set(type + hex, tint = type === "water" ? { water: hex } : { tint: hex })
    }
    cache.set(key, tint)
    return tint
  }
}
