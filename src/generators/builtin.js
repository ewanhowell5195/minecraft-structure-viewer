import { rnd, shuffle, OPP } from "../transforms.js"
import { loadLibrary } from "../lib.js"
import { usePacks } from "../composables/usePacks.js"
import { runMonument } from "./monument.js"
import { mineshaftPieceGens, runMineshaftRoom, runMineshaftRoomMesa } from "./mineshaft.js"
import { makeEndSpikeSize } from "./endspikes.js"

// nbt-less structures: the tree entry is synthesized, loads run the generator at seed 0
export const GENERATED = {
  "minecraft/builtin/ocean_monument": runMonument,
  "minecraft/builtin/mineshaft/normal/room": runMineshaftRoom,
  "minecraft/builtin/mineshaft/mesa/room": runMineshaftRoomMesa
}
for (let size = 0; size < 10; size++) {
  const caged = size === 1 || size === 2 ? "_caged" : ""
  GENERATED[`minecraft/builtin/end/spike_${76 + size * 3}${caged}`] = makeEndSpikeSize(size)
}
for (const type of ["normal", "mesa"]) {
  for (const len of [10, 15, 20]) {
    GENERATED[`minecraft/builtin/mineshaft/${type}/corridor_${len}`] = mineshaftPieceGens[`mineshaft_${type}_corridor_${len}`]
    GENERATED[`minecraft/builtin/mineshaft/${type}/spider_corridor_${len}`] = mineshaftPieceGens[`mineshaft_${type}_spider_corridor_${len}`]
    GENERATED[`minecraft/builtin/mineshaft/${type}/suspended_corridor_${len}`] = mineshaftPieceGens[`mineshaft_${type}_suspended_corridor_${len}`]
  }
}

// fixers: the nbts are one canonical roll; the .rand.json sidecars list the
// selector-controlled cells, re-rolled here with the game's distributions

const AIRISH = /(^|:)(cave_)?air$/

export async function readMasks(name) {
  const packs = usePacks()
  const lib = await loadLibrary()
  const buf = await lib.readFile(`data/minecraft/structure/builtin/${name}.rand.json`, packs.assets.value)
  return buf ? JSON.parse(new TextDecoder().decode(buf)) : null
}

const key = p => p[0] + "," + p[1] + "," + p[2]

function cellMap(s) {
  const m = new Map()
  for (const b of s.blocks) m.set(key(b.pos), b)
  return m
}

function statePicker(s) {
  const byKey = new Map(s.palette.map((e, i) => [e.Name + "|" + JSON.stringify(e.Properties ?? null), i]))
  return (Name, Properties) => {
    const pk = Name + "|" + JSON.stringify(Properties ?? null)
    let i = byKey.get(pk)
    if (i === undefined) {
      i = s.palette.length
      s.palette.push(Properties ? { Name, Properties } : { Name })
      byKey.set(pk, i)
    }
    return i
  }
}

function setCell(s, cells, stateFor, pos, Name, Properties, nbt) {
  const b = cells.get(key(pos))
  if (!b) return
  b.state = stateFor(Name, Properties)
  if (nbt !== undefined) {
    if (nbt) b.nbt = nbt
    else delete b.nbt
  }
}

// ---- jungle temple

function fixJungleTemple(s, masks, rand) {
  const cells = cellMap(s), stateFor = statePicker(s)
  for (const p of masks.moss) {
    setCell(s, cells, stateFor, p, rand() < 0.4 ? "minecraft:cobblestone" : "minecraft:mossy_cobblestone")
  }
}

// ---- desert pyramid

function fixDesertPyramid(s, masks, rand) {
  const cells = cellMap(s), stateFor = statePicker(s)
  const sus = p => setCell(s, cells, stateFor, p, "minecraft:suspicious_sand", undefined,
    { LootTable: "minecraft:archaeology/desert_pyramid" })
  for (const p of masks.collapsed_roof) {
    setCell(s, cells, stateFor, p, rand() < 0.33 ? "minecraft:sandstone" : "minecraft:sand")
  }
  const [lo, hi] = masks.stair_variant
  const variant = rand() < 0.5
  setCell(s, cells, stateFor, lo, variant ? "minecraft:sand" : "minecraft:sandstone")
  setCell(s, cells, stateFor, hi, variant ? "minecraft:sandstone" : "minecraft:sand")
  const pool = shuffle(masks.suspicious_sand, rand)
  const count = Math.min(pool.length, 5 + Math.floor(rand() * 3))
  for (let i = 0; i < count; i++) sus(pool[i])
  sus(masks.collapsed_roof[Math.floor(rand() * masks.collapsed_roof.length)])
}

// ---- desert well

function fixDesertWell(s, masks, rand) {
  const cells = cellMap(s), stateFor = statePicker(s)
  for (const depth of [1, 2]) {
    const [x, y, z] = masks.well_water[Math.floor(rand() * masks.well_water.length)]
    setCell(s, cells, stateFor, [x, y - depth, z], "minecraft:suspicious_sand", undefined,
      { LootTable: "minecraft:archaeology/desert_well" })
  }
}

// ---- dungeon (MonsterRoomFeature)

const DUNGEON_MOBS = ["minecraft:skeleton", "minecraft:zombie", "minecraft:zombie", "minecraft:spider"]

function fixDungeon(s, masks, rand) {
  const cells = cellMap(s), stateFor = statePicker(s)
  for (const p of masks.floor) {
    setCell(s, cells, stateFor, p, Math.floor(rand() * 4) !== 0 ? "minecraft:mossy_cobblestone" : "minecraft:cobblestone")
  }
  const [sx, , sz] = s.size
  const ox = (sx - 1) / 2, oz = (sz - 1) / 2, xr = (sx - 3) / 2, zr = (sz - 3) / 2
  const STEP = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
  const CW = { north: "east", east: "south", south: "west", west: "north" }
  const at = (p, d) => [p[0] + STEP[d][0], 1, p[2] + STEP[d][1]]
  const nameAt = p => s.palette[cells.get(key(p))?.state]?.Name || ""
  const empty = p => !cells.has(key(p)) || AIRISH.test(nameAt(p))
  // wall counting is isSolid; the facing pick is isSolidRender (full cubes only)
  const isSolid = p => cells.has(key(p)) && !AIRISH.test(nameAt(p))
  const solidRender = p => /cobblestone$/.test(nameAt(p))
  const isChest = p => /(^|:)chest$/.test(nameAt(p))
  // StructurePiece.reorient
  function reorient(p) {
    let unique = null
    for (const d of ["north", "south", "west", "east"]) {
      if (isChest(at(p, d))) return "north"
      if (solidRender(at(p, d))) {
        if (unique) { unique = null; break }
        unique = d
      }
    }
    if (unique) return OPP[unique]
    let f = "north"
    if (solidRender(at(p, f))) f = OPP[f]
    if (solidRender(at(p, f))) f = CW[f]
    if (solidRender(at(p, f))) f = OPP[f]
    return f
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let i = 0; i < 3; i++) {
      const x = ox + Math.floor(rand() * (xr * 2 + 1)) - xr
      const z = oz + Math.floor(rand() * (zr * 2 + 1)) - zr
      const pos = [x, 1, z]
      if (!empty(pos)) continue
      let wallCount = 0
      for (const d of ["north", "south", "west", "east"]) if (isSolid(at(pos, d))) wallCount++
      if (wallCount !== 1) continue
      setCell(s, cells, stateFor, pos, "minecraft:chest", { facing: reorient(pos), type: "single" },
        { LootTable: "minecraft:chests/simple_dungeon", id: "minecraft:chest" })
      break
    }
  }
  // same-facing neighbours join into doubles; clockwise of facing = left
  const chests = s.blocks.filter(b => /(^|:)chest$/.test(s.palette[b.state]?.Name || ""))
  for (const c of chests) {
    const f = s.palette[c.state].Properties.facing
    for (const d of [CW[f], OPP[CW[f]]]) {
      const other = cells.get(key(at(c.pos, d)))
      if (!other || !/(^|:)chest$/.test(s.palette[other.state]?.Name || "")) continue
      if (s.palette[other.state].Properties.facing !== f) continue
      c.state = stateFor("minecraft:chest", { facing: f, type: d === CW[f] ? "left" : "right" })
    }
  }
  const spawner = cells.get(key([ox, 1, oz]))
  if (spawner) spawner.nbt = {
    id: "minecraft:mob_spawner",
    SpawnData: { entity: { id: DUNGEON_MOBS[Math.floor(rand() * DUNGEON_MOBS.length)] } }
  }
}

const FIXERS = {
  "minecraft/builtin/jungle_temple": ["jungle_temple", fixJungleTemple],
  "minecraft/builtin/desert_pyramid": ["desert_pyramid", fixDesertPyramid],
  "minecraft/builtin/desert_well": ["desert_well", fixDesertWell],
  "minecraft/builtin/dungeon/5x5": ["dungeon/5x5", fixDungeon],
  "minecraft/builtin/dungeon/7x5": ["dungeon/7x5", fixDungeon],
  "minecraft/builtin/dungeon/5x7": ["dungeon/5x7", fixDungeon],
  "minecraft/builtin/dungeon/7x7": ["dungeon/7x7", fixDungeon]
}

// applied by every load of a builtin structure (fresh roll each time)
export async function fixBuiltin(rel, structure, seed = (Math.random() * 0x100000000) >>> 0) {
  const entry = FIXERS[rel]
  if (!entry) return structure
  const masks = await readMasks(entry[0])
  if (masks) entry[1](structure, masks, rnd(seed))
  return structure
}

export const rerollGen = rel => async (loadStruct, { seed } = {}) => {
  const s = await loadStruct(rel.replace(/^minecraft\//, ""))
  return { structure: await fixBuiltin(rel, s, seed), maxDepth: 1 }
}

export const runJungleTemple = rerollGen("minecraft/builtin/jungle_temple")
export const runDesertPyramid = rerollGen("minecraft/builtin/desert_pyramid")
export const runDesertWell = rerollGen("minecraft/builtin/desert_well")

// the dungeon also re-rolls its size, like the game's two nextInt(2) calls
export async function runDungeon(loadStruct, { seed } = {}) {
  const rand = rnd(seed ?? (Math.random() * 0x100000000) >>> 0)
  const size = `${Math.floor(rand() * 2) * 2 + 5}x${Math.floor(rand() * 2) * 2 + 5}`
  const rel = `minecraft/builtin/dungeon/${size}`
  const s = await loadStruct(rel.replace(/^minecraft\//, ""))
  const masks = await readMasks(`dungeon/${size}`)
  if (masks) fixDungeon(s, masks, rand)
  return { structure: s, maxDepth: 1 }
}
