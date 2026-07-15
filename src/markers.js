import { rotDir } from "./transforms.js"

const SB = /(^|:)structure_block$/
const FAMILIES = new Set(["igloo", "underwater_ruin", "shipwreck", "woodland_mansion", "end_city"])

export function markerFamily(name) {
  const m = /^minecraft\/([^/]+)/.exec(name ?? "")
  return m && FAMILIES.has(m[1]) ? m[1] : null
}

export function hasDataMarkers(structure, name) {
  if (!structure || !markerFamily(name)) return false
  return structure.blocks.some(b => SB.test(structure.palette[b.state]?.Name ?? "") && b.nbt?.mode === "DATA")
}

const SHIPWRECK_LOOT = {
  map_chest: "shipwreck_map",
  treasure_chest: "shipwreck_treasure",
  supply_chest: "shipwreck_supply"
}
const MANSION_FACING = { ChestWest: "west", ChestEast: "east", ChestSouth: "south", ChestNorth: "north" }
const FRAME_FACING = { north: 2, south: 3, west: 4, east: 5 }

export function processDataMarkers(structure, name, rand) {
  const family = markerFamily(name)
  const palette = structure.palette.slice()
  const paletteIdx = new Map(palette.map((e, i) => [e?.Name + "|" + JSON.stringify(e?.Properties ?? null), i]))
  function stateFor(Name, Properties) {
    const key = Name + "|" + JSON.stringify(Properties ?? null)
    let i = paletteIdx.get(key)
    if (i === undefined) {
      i = palette.length
      paletteIdx.set(key, i)
      palette.push(Properties ? { Name, Properties } : { Name })
    }
    return i
  }

  const blocks = []
  const markers = []
  for (const b of structure.blocks) {
    if (SB.test(palette[b.state]?.Name ?? "") && b.nbt?.mode === "DATA") markers.push(b)
    else blocks.push(b)
  }
  const entities = structure.entities ? structure.entities.slice() : []
  const posKey = p => p.join(",")
  const byPos = new Map(blocks.map((b, i) => [posKey(b.pos), i]))

  const setLoot = (pos, table) => {
    const i = byPos.get(posKey(pos))
    if (i == null) return
    blocks[i] = { ...blocks[i], nbt: { ...(blocks[i].nbt ?? {}), LootTable: "minecraft:chests/" + table } }
  }
  const placeChest = (pos, table, facing = "north") => {
    const nb = {
      state: stateFor("minecraft:chest", { facing, type: "single", waterlogged: "false" }),
      pos: pos.slice(),
      nbt: { id: "minecraft:chest", LootTable: "minecraft:chests/" + table }
    }
    const i = byPos.get(posKey(pos))
    if (i == null) {
      byPos.set(posKey(pos), blocks.length)
      blocks.push(nb)
    } else blocks[i] = nb
  }
  const spawn = (pos, nbt) => entities.push({ pos: [pos[0] + 0.5, pos[1], pos[2] + 0.5], nbt })

  for (const m of markers) {
    const tag = typeof m.nbt?.metadata === "string" ? m.nbt.metadata : ""
    const rot = m.nbt?.__rot ?? 0
    const below = [m.pos[0], m.pos[1] - 1, m.pos[2]]
    switch (family) {
      case "igloo":
        if (tag === "chest") setLoot(below, "igloo_chest")
        break
      case "shipwreck":
        if (SHIPWRECK_LOOT[tag]) setLoot(below, SHIPWRECK_LOOT[tag])
        break
      case "underwater_ruin":
        if (tag === "chest") placeChest(m.pos, name.includes("big") ? "underwater_ruin_big" : "underwater_ruin_small")
        else if (tag === "drowned") spawn(m.pos, { id: "minecraft:drowned" })
        break
      case "end_city":
        if (tag.startsWith("Chest")) setLoot(below, "end_city_treasure")
        else if (tag.startsWith("Sentry")) spawn(m.pos, { id: "minecraft:shulker" })
        else if (tag.startsWith("Elytra")) {
          entities.push({ pos: [m.pos[0] + 0.5, m.pos[1] + 0.5, m.pos[2] + 0.5], nbt: { id: "minecraft:item_frame", Facing: FRAME_FACING[rotDir("south", rot)], Item: { count: 1, id: "minecraft:elytra" } } })
        }
        break
      case "woodland_mansion":
        if (tag.startsWith("Chest")) placeChest(m.pos, "woodland_mansion", rotDir(MANSION_FACING[tag] ?? "north", rot))
        else if (tag === "Mage") spawn(m.pos, { id: "minecraft:evoker" })
        else if (tag === "Warrior") spawn(m.pos, { id: "minecraft:vindicator" })
        else if (tag === "Group of Allays") {
          const n = Math.floor(rand() * 3) + 1
          for (let i = 0; i < n; i++) spawn(m.pos, { id: "minecraft:allay" })
        }
        break
    }
  }
  return { ...structure, palette, blocks, entities }
}
