import { before } from "./legacyRenames.js"

const COLORS = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "silver", "cyan", "purple", "blue", "brown", "green", "red", "black"]
const DYES = COLORS.toReversed()
const WOODS = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak"]
const FISH = ["cod", "salmon", "clownfish", "pufferfish"]
const COLOR_FAMILIES = ["wool", "carpet", "stained_glass", "stained_glass_pane", "stained_hardened_clay", "concrete", "concrete_powder"]

const VARIANTS = {
  boat: "oak_boat",
  fence: "oak_fence",
  fence_gate: "oak_fence_gate",
  wooden_door: "oak_door",
  "stone_slab2#0": "red_sandstone_slab",
  "yellow_flower#0": "dandelion",
  "red_flower#0": "poppy",
  "red_flower#1": "blue_orchid",
  "red_flower#2": "allium",
  "red_flower#3": "houstonia",
  "red_flower#4": "red_tulip",
  "red_flower#5": "orange_tulip",
  "red_flower#6": "white_tulip",
  "red_flower#7": "pink_tulip",
  "red_flower#8": "oxeye_daisy",
  "double_plant#0": "sunflower",
  "double_plant#1": "syringa",
  "double_plant#4": "double_rose",
  "double_plant#5": "paeonia"
}
for (const family of COLOR_FAMILIES) {
  COLORS.forEach((color, i) => VARIANTS[`${family}#${i}`] = `${color}_${family}`)
}
DYES.forEach((dye, i) => VARIANTS[`dye#${i}`] = `dye_${dye}`)
FISH.forEach((fish, i) => {
  VARIANTS[`fish#${i}`] = fish
  if (i < 2) VARIANTS[`cooked_fish#${i}`] = `cooked_${fish}`
})
WOODS.forEach((wood, i) => {
  VARIANTS[`planks#${i}`] = `${wood}_planks`
  VARIANTS[`wooden_slab#${i}`] = `${wood}_slab`
  VARIANTS[`sapling#${i}`] = `${wood}_sapling`
  VARIANTS[`leaves${i < 4 ? "" : "2"}#${i % 4}`] = `${wood}_leaves`
  if (i < 4) VARIANTS[`log#${i}`] = `${wood}_log`
})
VARIANTS["log2#0"] = "acacia_log"
VARIANTS["log2#1"] = "dark_oak_log"

export function legacyItemId(id, data, version) {
  if (typeof id !== "string" || !version || !before(version, "1.13")) return id
  const ns = id.startsWith("minecraft:") ? "minecraft:" : ""
  const bare = id.replace(/^minecraft:/, "")
  return ns + (VARIANTS[`${bare}#${Number(data ?? 0)}`] ?? VARIANTS[bare] ?? bare)
}

const ASSET_ALIASES = {
  totem_of_undying: "totem",
  potion: "bottle_drinkable",
  splash_potion: "bottle_splash",
  lingering_potion: "bottle_lingering",
  anvil: "anvil_intact"
}

export function legacyAssetAlias(id) {
  return ASSET_ALIASES[id.replace(/^minecraft:/, "")]
}
