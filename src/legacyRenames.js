const RENAMES = {
  spawner: ["1.13", "mob_spawner"]
}

function before(version, threshold) {
  const parse = v => String(v).split("-")[0].split(".").map(Number)
  const a = parse(version), b = parse(threshold)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d < 0
  }
  return false
}

export function applyLegacyRenames(structure, version) {
  if (!version || !structure?.palette) return structure
  for (const e of structure.palette) {
    const r = RENAMES[e?.id?.replace(/^minecraft:/, "")]
    if (r && before(version, r[0])) e.id = "minecraft:" + r[1]
  }
  return structure
}

function take(props, key) {
  const value = props[key]
  delete props[key]
  return value
}

const FLATTEN = {
  bed: "red_bed",
  carpet: p => take(p, "color") + "_carpet",
  wool: p => take(p, "color") + "_wool",
  stained_glass: p => take(p, "color") + "_stained_glass",
  planks: p => take(p, "variant") + "_planks",
  wooden_slab: p => take(p, "variant") + "_slab",
  double_wooden_slab: p => take(p, "variant") + "_double_slab",
  stone_slab: p => take(p, "variant") + "_slab",
  purpur_slab: p => {
    delete p.variant
    return "purpur_slab"
  },
  cobblestone_wall: p => {
    delete p.variant
    if (p.up === "false" && ["north", "east", "south", "west"].every(k => p[k] === "false")) p.up = "true"
    return "cobblestone_wall"
  },
  double_stone_slab: p => {
    delete p.seamless
    return take(p, "variant") + "_double_slab"
  },
  leaves2: p => take(p, "variant") + "_leaves",
  log2: p => take(p, "variant") + "_log",
  sapling: p => take(p, "type") + "_sapling",
  monster_egg: p => take(p, "variant") + "_monster_egg",
  stone: p => take(p, "variant"),
  stonebrick: p => take(p, "variant"),
  dirt: p => take(p, "variant"),
  skull: p => {
    delete p.nodrop
    if (p.facing === "up" || p.facing === "down") {
      delete p.facing
      return "skeleton_skull"
    }
    return "skeleton_wall_skull"
  },
  wall_sign: "oak_wall_sign",
  wall_banner: "white_wall_banner"
}

export function applyPreFlattening(structure, version) {
  if (!version || !before(version, "1.13") || !structure?.palette) return structure
  for (const e of structure.palette) {
    const entry = FLATTEN[e?.id?.replace(/^minecraft:/, "")]
    if (!entry) continue
    const props = { ...e.properties }
    e.id = "minecraft:" + (typeof entry === "string" ? entry : entry(props))
    if (Object.keys(props).length) e.properties = props
    else delete e.properties
  }
  return structure
}
