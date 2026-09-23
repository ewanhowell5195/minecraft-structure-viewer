const MODIFIERS = { dark_forest: c => ((c & 0xFEFEFE) + 0x28340A) >> 1, swamp: () => 0x4C763C }
const TYPES = ["grass", "foliage", "dry_foliage", "water"]
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
  if (!t) tables.set(assets, t = { defs: new Map(), tints: new Map() })
  return t
}

async function definition(lib, assets, t, id) {
  if (!t.defs.has(id)) {
    const [ns, path] = id.includes(":") ? id.split(":") : ["minecraft", id]
    t.defs.set(id, lib.readFile(`data/${ns}/worldgen/biome/${path}.json`, assets).then(buf => buf ? JSON.parse(new TextDecoder().decode(buf)) : null).catch(() => null))
  }
  return t.defs.get(id)
}

async function tintOf(lib, assets, t, id, type) {
  const key = id + "\0" + type
  if (t.tints.has(key)) return t.tints.get(key)
  const p = (async () => {
    const d = await definition(lib, assets, t, id)
    const fixed = d?.effects?.[type + "_color"]
    let color
    if (fixed !== undefined) color = typeof fixed === "number" ? fixed : parseInt(String(fixed).replace("#", ""), 16)
    else if (type === "water") return null
    else color = parseInt((await lib.getBiomeTint(assets, type, { temperature: d?.temperature ?? 0.5, downfall: d?.downfall ?? 1 })).slice(1), 16)
    const modifier = type === "grass" ? MODIFIERS[d?.effects?.grass_color_modifier] : null
    if (modifier) color = modifier(color)
    const hex = "#" + color.toString(16).padStart(6, "0")
    return type === "water" ? { water: hex } : { tint: hex }
  })()
  t.tints.set(key, p)
  return p
}

export async function biomeTints(lib, assets, ids) {
  const t = table(assets)
  const out = new Map()
  for (const id of ids) for (const type of TYPES) {
    const tint = await tintOf(lib, assets, t, id, type)
    if (tint) out.set(id + "\0" + type, tint)
  }
  return out
}
