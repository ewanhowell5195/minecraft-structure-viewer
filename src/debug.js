// Hand-built showroom for the greedy mesher, loaded via ?debug. Nothing hides
// behind anything; toggle wireframe to see whether a run merges into one quad.
// Each row is a case the mesher should handle.
export function makeDebug() {
  const palette = [], pi = new Map()
  const st = (Name, Properties = {}) => {
    const k = Name + JSON.stringify(Properties)
    if (!pi.has(k)) {
      palette.push({ Name: "minecraft:" + Name, Properties })
      pi.set(k, palette.length - 1)
    }
    return pi.get(k)
  }
  const blocks = [], put = (x, y, z, name, props) => blocks.push({ pos: [x, y, z], state: st(name, props) })
  const run = (z, name, props, n = 6, y = 0) => { for (let i = 0; i < n; i++) put(i, y, z, name, props) }
  // different models, same texture, coplanar 16x16 tops: should all merge
  put(0, 0, 0, "cobblestone"); put(1, 0, 0, "cobblestone_slab", { type: "double" })
  put(2, 0, 0, "cobblestone"); put(3, 0, 0, "cobblestone_slab", { type: "double" }); put(4, 0, 0, "cobblestone")
  run(2, "oak_slab", { type: "bottom" })                          // bottom slab floor: one top quad
  run(4, "oak_slab", { type: "top" })                             // top slab floor
  run(6, "oak_stairs", { half: "bottom", facing: "east", shape: "straight" }) // stair run
  // rotated logs (x,y,z) then a matching-axis pair that should merge
  put(0, 0, 8, "oak_log", { axis: "x" }); put(1, 0, 8, "oak_log", { axis: "y" }); put(2, 0, 8, "oak_log", { axis: "z" })
  put(4, 0, 8, "oak_log", { axis: "x" }); put(5, 0, 8, "oak_log", { axis: "x" })
  for (let i = 0; i < 3; i++) put(i * 2, 0, 10, "grass_block")    // grass, gapped so overlay sides show
  for (let i = 0; i < 6; i++) put(i, 0, 12, i % 2 ? "cobblestone" : "oak_planks") // two-texture checker
  for (let i = 0; i < 3; i++) put(i * 2, 0, 14, "glass")          // glass, gapped (self-cull is future)
  run(16, "cobblestone_wall", {}, 4)                              // walls (partial faces)
  put(0, 0, 18, "oak_planks"); put(0, 1, 18, "oak_planks"); put(1, 0, 18, "oak_slab", { type: "bottom" }) // cull: slab against a cube
  run(20, "dirt_path")                                            // 15/16-tall top (never culls): tops merge, sides partial
  put(0, 0, 22, "grass_block"); put(1, 0, 22, "dirt_path"); put(2, 0, 22, "grass_block") // path between full cubes: shared sides cull
  // fluids: source (level 0) then flowing levels 1-7, each lower than the last
  for (let i = 0; i < 8; i++) put(i, 0, 24, "water", { level: String(i) })
  for (let i = 0; i < 8; i++) put(i, 0, 26, "lava", { level: String(i) })
  // stained glass wall (2 tall), mixed colours: same colour culls the shared
  // face (vertical pairs), different colours don't (horizontal neighbours)
  const glassCols = ["red", "orange", "yellow", "lime", "light_blue", "blue", "purple", "magenta"]
  for (let i = 0; i < glassCols.length; i++) {
    put(i, 0, 28, glassCols[i] + "_stained_glass")
    put(i, 1, 28, glassCols[i] + "_stained_glass")
  }
  const mx = a => Math.max(...blocks.map(b => b.pos[a])) + 1
  return { size: [mx(0), mx(1), mx(2)], palette, blocks }
}
