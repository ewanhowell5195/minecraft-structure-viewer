// steps: true grows through the level menu; only the entry counts as a starter
export const PROC = [
  { prefix: "minecraft/igloo/", entry: "minecraft/igloo/top", label: "Igloo", gen: "igloo", steps: true, maxDepth: 2 },
  { prefix: "minecraft/end_city/", entry: "minecraft/end_city/base_floor", label: "End City", gen: "end_city", steps: true, maxDepth: 8 },
  { prefix: "minecraft/woodland_mansion/", entry: "minecraft/woodland_mansion/entrance", label: "Woodland Mansion", gen: "mansion", steps: false },
  // reroll: loads with seed 0, Re-roll picks a fresh seed (which goes into the url)
  { prefix: "minecraft/builtin/jungle_temple", entry: "minecraft/builtin/jungle_temple", label: "Jungle Temple", gen: "jungle_temple", steps: false, reroll: true },
  { prefix: "minecraft/builtin/desert_pyramid", entry: "minecraft/builtin/desert_pyramid", label: "Desert Pyramid", gen: "desert_pyramid", steps: false, reroll: true },
  { prefix: "minecraft/builtin/desert_well", entry: "minecraft/builtin/desert_well", label: "Desert Well", gen: "desert_well", steps: false, reroll: true },
  // 5x5 is the real Dungeon generator (re-roll includes size); the others re-roll at fixed size
  { prefix: "minecraft/builtin/dungeon/", entry: "minecraft/builtin/dungeon/5x5", label: "Dungeon", gen: "dungeon", steps: false, reroll: true },
  { prefix: "minecraft/builtin/dungeon/7x5", entry: "minecraft/builtin/dungeon/7x5", label: "Dungeon", gen: "dungeon_7x5", steps: false, reroll: true },
  { prefix: "minecraft/builtin/dungeon/5x7", entry: "minecraft/builtin/dungeon/5x7", label: "Dungeon", gen: "dungeon_5x7", steps: false, reroll: true },
  { prefix: "minecraft/builtin/dungeon/7x7", entry: "minecraft/builtin/dungeon/7x7", label: "Dungeon", gen: "dungeon_7x7", steps: false, reroll: true },
  { prefix: "minecraft/builtin/nether_fortress/", entry: "minecraft/builtin/nether_fortress/bridge_crossing", label: "Nether Fortress", gen: "fortress", steps: true, maxDepth: 30 },
  // the End generates from the exit portal outward: the full build is portal plus ten spikes
  { prefix: "minecraft/builtin/end/exit_portal/inactive", entry: "minecraft/builtin/end/exit_portal/inactive", label: "End Spikes", gen: "end_spikes", steps: false },
  { prefix: "minecraft/builtin/end/exit_portal/active", entry: "minecraft/builtin/end/exit_portal/active", label: "End Spikes", gen: "end_spikes_active", steps: false },
  { prefix: "minecraft/builtin/stronghold/", entry: "minecraft/builtin/stronghold/stairs_down", label: "Stronghold", gen: "stronghold", steps: true, maxDepth: 50 },
  // the room is the game's start piece, so it hosts the full mineshaft session
  { prefix: "minecraft/builtin/mineshaft/normal/", entry: "minecraft/builtin/mineshaft/normal/room", label: "Mineshaft", gen: "mineshaft", steps: true, maxDepth: 9 },
  { prefix: "minecraft/builtin/mineshaft/mesa/", entry: "minecraft/builtin/mineshaft/mesa/room", label: "Badlands Mineshaft", gen: "mineshaft_mesa", steps: true, maxDepth: 9 },
  { prefix: "minecraft/builtin/ocean_monument", entry: "minecraft/builtin/ocean_monument", label: "Ocean Monument", gen: "monument", steps: false }
]

for (const type of ["normal", "mesa"]) {
  for (const len of [10, 15, 20]) {
    const at = name => `minecraft/builtin/mineshaft/${type}/${name}_${len}`
    PROC.push({ prefix: at("corridor"), entry: at("corridor"), label: "Mineshaft Corridor", gen: `mineshaft_${type}_corridor_${len}`, steps: false, reroll: true })
    PROC.push({ prefix: at("spider_corridor"), entry: at("spider_corridor"), label: "Spider Corridor", gen: `mineshaft_${type}_spider_corridor_${len}`, steps: false, reroll: true })
    PROC.push({ prefix: at("suspended_corridor"), entry: at("suspended_corridor"), label: "Suspended Corridor", gen: `mineshaft_${type}_suspended_corridor_${len}`, steps: false, reroll: true })
  }
}
