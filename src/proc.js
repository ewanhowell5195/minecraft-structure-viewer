// Procedural structures are assembled in code, not template pools, so their
// pieces can't be detected as pieces by the worldgen scan. Only the entry
// counts as a starter. steps: true grows through the level menu; the mansion
// flood-fills in one pass so it just builds whole.
export const PROC = [
  { prefix: "minecraft/igloo/", entry: "minecraft/igloo/top", label: "Igloo", gen: "igloo", steps: true, maxDepth: 2 },
  { prefix: "minecraft/end_city/", entry: "minecraft/end_city/base_floor", label: "End City", gen: "end_city", steps: true, maxDepth: 8 },
  { prefix: "minecraft/woodland_mansion/", entry: "minecraft/woodland_mansion/entrance", label: "Woodland Mansion", gen: "mansion", steps: false },
  // extracted hardcoded structures with random cells: Regenerate re-rolls them
  { prefix: "minecraft/builtin/jungle_temple", entry: "minecraft/builtin/jungle_temple", label: "Jungle Temple", gen: "jungle_temple", steps: false },
  { prefix: "minecraft/builtin/desert_pyramid", entry: "minecraft/builtin/desert_pyramid", label: "Desert Pyramid", gen: "desert_pyramid", steps: false },
  { prefix: "minecraft/builtin/desert_well", entry: "minecraft/builtin/desert_well", label: "Desert Well", gen: "desert_well", steps: false },
  { prefix: "minecraft/builtin/dungeon/", entry: "minecraft/builtin/dungeon/5x5", label: "Dungeon", gen: "dungeon", steps: false },
  { prefix: "minecraft/builtin/nether_fortress/", entry: "minecraft/builtin/nether_fortress/bridge_crossing", label: "Nether Fortress", gen: "fortress", steps: true, maxDepth: 30 }
]
