export function makeDebug(kind) {
  const palette = [], pi = new Map()
  function st(Name, Properties = {}) {
    const k = Name + JSON.stringify(Properties)
    if (!pi.has(k)) {
      palette.push({ Name: "minecraft:" + Name, Properties })
      pi.set(k, palette.length - 1)
    }
    return pi.get(k)
  }
  const blocks = [], put = (x, y, z, name, props) => blocks.push({ pos: [x, y, z], state: st(name, props) })
  const run = (z, name, props, n = 6, y = 0) => { for (let i = 0; i < n; i++) put(i, y, z, name, props) }
  function finish() {
    const mx = a => Math.max(...blocks.map(b => b.pos[a])) + 1
    return { size: [mx(0), mx(1), mx(2)], palette, blocks }
  }

  if (kind === "fluid") {
    const water = (x, y, z, level) => put(x, y, z, "water", { level: String(level) })
    function floor(x0, z0, x1, z1, y = 0, name = "stone") {
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) put(x, y, z, name)
    }
    function rect(x0, z0, x1, z1) {
      const out = []
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push([x, z])
      return out
    }
    // the game's flat-ground spread: level +1 per step, solids block, dead past 7
    function spread(cells, sources, solids, place) {
      const k = (x, z) => x + "," + z
      const solid = new Set(solids.map(c => k(...c)))
      const region = new Set(cells.map(c => k(...c)))
      const level = new Map(sources.map(c => [k(...c), 0]))
      let frontier = sources.slice()
      while (frontier.length) {
        const next = []
        for (const [x, z] of frontier) {
          const l = level.get(k(x, z))
          if (l >= 7) continue
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = k(x + dx, z + dz)
            if (!region.has(nk) || solid.has(nk) || level.has(nk)) continue
            level.set(nk, l + 1)
            next.push([x + dx, z + dz])
          }
        }
        frontier = next
      }
      for (const [ck, l] of level) {
        const [x, z] = ck.split(",").map(Number)
        place(x, z, l)
      }
    }

    // 1: bare air-flanked run (pathological corner sag)
    for (let i = 0; i < 8; i++) water(i, 0, 0, i)

    // 2: the same run in a walled stone channel, with a bridge block over it
    floor(0, 3, 7, 5)
    for (let x = 0; x <= 7; x++) { put(x, 1, 3, "stone"); put(x, 1, 5, "stone") }
    for (let i = 0; i < 8; i++) water(i, 1, 4, i)
    put(4, 2, 4, "stone")

    // 3: flowing past an obstacle
    floor(0, 8, 11, 12)
    const obstacle = [[3, 10], [4, 10]]
    for (const [x, z] of obstacle) put(x, 1, z, "stone")
    spread(rect(0, 8, 11, 12), [[0, 10]], obstacle, (x, z, l) => water(x, 1, z, l))

    // 4: funnelling through a one-block gap in a wall
    floor(0, 15, 11, 19)
    const wall = []
    for (let z = 15; z <= 19; z++) if (z !== 17) { put(3, 1, z, "stone"); wall.push([3, z]) }
    spread(rect(0, 15, 11, 19), [[0, 17]], wall, (x, z, l) => water(x, 1, z, l))

    // 5: full open spread from a central source (diamond)
    floor(0, 22, 14, 36)
    spread(rect(0, 22, 14, 36), [[7, 29]], [], (x, z, l) => water(x, 1, z, l))

    // 6: waterfall over the edge (falling level 8) onto the floor below
    floor(0, 39, 3, 39, 3)
    for (let x = 0; x <= 3; x++) { put(x, 4, 38, "stone"); put(x, 4, 40, "stone") }
    for (let i = 0; i <= 3; i++) water(i, 4, 39, i)
    water(4, 4, 39, 4)
    water(4, 3, 39, 8)
    water(4, 2, 39, 8)
    floor(2, 37, 11, 41)
    spread(rect(2, 37, 11, 41), [[4, 39]], [], (x, z, l) => water(x, 1, z, l === 0 ? 8 : l))

    // 7: glass-walled channel (overlay/transparent neighbour case)
    floor(0, 44, 7, 46)
    for (let x = 0; x <= 7; x++) { put(x, 1, 44, "glass"); put(x, 1, 46, "glass") }
    for (let i = 0; i < 8; i++) water(i, 1, 45, i)

    // 8: lava for contrast: overworld dropoff is 2, so levels 0, 2, 4, 6
    floor(10, 44, 14, 46)
    for (let x = 10; x <= 14; x++) { put(x, 1, 44, "stone"); put(x, 1, 46, "stone") }
    for (let i = 0; i < 4; i++) put(10 + i, 1, 45, "lava", { level: String(i * 2) })

    // 9: an L-bend corridor: flow turns a corner
    const path = []
    for (let z = 3; z <= 8; z++) path.push([15, z])
    for (let x = 16; x <= 20; x++) path.push([x, 8])
    floor(14, 2, 21, 9)
    const pathSet = new Set(path.map(c => c.join(",")))
    for (let x = 14; x <= 21; x++) for (let z = 2; z <= 9; z++) {
      if (!pathSet.has(x + "," + z)) put(x, 1, z, "stone")
    }
    spread(path, [[15, 3]], [], (x, z, l) => water(x, 1, z, l))

    // 10: a 3x3 source pool overflowing through an open east side
    floor(24, 2, 34, 8)
    for (let z = 2; z <= 8; z++) put(24, 1, z, "stone")
    for (let x = 24; x <= 28; x++) { put(x, 1, 2, "stone"); put(x, 1, 8, "stone") }
    put(28, 1, 3, "stone"); put(28, 1, 7, "stone")
    spread(rect(25, 3, 34, 7), rect(25, 3, 27, 7), [[28, 3], [28, 7]], (x, z, l) => water(x, 1, z, l))

    return finish()
  }

  if (kind === "lighting1") {
    put(0, 0, 0, "stone")
    return finish()
  }

  if (kind === "lighting2") {
    for (let x = 0; x <= 30; x++) for (let z = 0; z <= 30; z++) put(x, 0, z, "stone")
    return finish()
  }

  if (kind === "lighting3") {
    for (let x = 0; x <= 30; x++) for (let z = 0; z <= 30; z++) {
      if (x === 0 || x === 30 || z === 0 || z === 30) put(x, 0, z, "stone")
    }
    return finish()
  }

  if (kind === "lighting4") {
    for (let x = 0; x <= 30; x++) for (let z = 0; z <= 30; z++) put(x, 0, z, "stone")
    put(15, 1, 15, "torch")
    return finish()
  }

  if (kind === "lighting5") {
    const floor = (x0, z0, x1, z1, y = 0, name = "stone") => { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) put(x, y, z, name) }
    const ring = (x0, z0, x1, z1, y0, y1, name = "stone") => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        if (x === x0 || x === x1 || z === z0 || z === z1) put(x, y, z, name)
      }
    }

    // 1: emitter pool sizes side by side
    floor(0, 0, 72, 14)
    put(4, 1, 7, "torch")
    put(20, 1, 7, "soul_torch")
    put(36, 1, 7, "redstone_torch", { lit: "true" })
    put(52, 1, 7, "lantern", { hanging: "false" })
    put(68, 1, 7, "glowstone")

    // 2: sealed room, torch inside, one doorway to spill through
    floor(0, 22, 12, 38)
    for (let y = 1; y <= 3; y++) for (let x = 2; x <= 10; x++) for (let z = 26; z <= 34; z++) {
      if (x !== 2 && x !== 10 && z !== 26 && z !== 34) continue
      if (x === 6 && z === 26 && y <= 2) continue
      put(x, y, z, "stone")
    }
    floor(2, 26, 10, 34, 4)
    put(6, 1, 30, "torch")

    // 3: two open-top chambers sharing a thin wall, torch on one side only
    floor(20, 22, 36, 34)
    ring(21, 23, 35, 33, 1, 2)
    for (let y = 1; y <= 2; y++) for (let z = 24; z <= 32; z++) put(28, y, z, "stone")
    put(24, 1, 28, "torch")

    // 4: elevated platform on a pillar: soft square shadow under, none beside
    floor(44, 22, 68, 40)
    floor(50, 25, 62, 37, 6)
    for (let y = 1; y <= 5; y++) put(56, y, 31, "stone")

    // 5: water basin: sky attenuation by depth, glowstone on the floor
    floor(76, 22, 92, 38)
    ring(78, 24, 90, 36, 1, 3)
    for (let y = 1; y <= 3; y++) for (let x = 79; x <= 89; x++) for (let z = 25; z <= 35; z++) {
      if (x === 84 && z === 30 && y === 1) continue
      put(x, y, z, "water", { level: "0" })
    }
    put(84, 1, 30, "glowstone")

    // 6: tunnel through a solid mass: end gradients meet in the middle
    floor(0, 46, 24, 60)
    for (let y = 1; y <= 5; y++) for (let x = 3; x <= 21; x++) for (let z = 49; z <= 57; z++) {
      if (y <= 3 && z >= 52 && z <= 54) continue
      put(x, y, z, "stone")
    }

    // 7: torch corridor: the stair wall passes light, the solid wall passes none
    floor(32, 46, 52, 62)
    for (let z = 49; z <= 59; z++) {
      for (let y = 1; y <= 3; y++) put(38, y, z, "stone")
      put(44, 1, z, "oak_stairs", { facing: "west", half: "bottom", shape: "straight" })
      for (let y = 2; y <= 3; y++) put(44, y, z, "stone")
    }
    put(41, 1, 54, "torch")

    // 8: wall torches on a tall pillar: light on vertical surfaces
    floor(60, 46, 76, 62)
    for (let y = 1; y <= 8; y++) floor(67, 53, 69, 55, y)
    put(66, 3, 54, "wall_torch", { facing: "west" })
    put(68, 3, 52, "wall_torch", { facing: "north" })

    // 9: lava pond: emitting fluid
    floor(84, 46, 98, 60)
    ring(86, 48, 96, 58, 1, 1)
    for (let x = 87; x <= 95; x++) for (let z = 49; z <= 57; z++) put(x, 1, z, "lava", { level: "0" })

    return finish()
  }

  if (kind === "pane") {
    put(0, 0, 0, "glass_pane", { north: "false", south: "false", east: "true", west: "true", waterlogged: "false" })
    return finish()
  }

  // dynamic special models: the animated book plus poseable chest and shulker
  if (kind === "dynamic") {
    put(0, 0, 0, "enchanting_table")
    put(2, 0, 0, "chest", { facing: "south", type: "single", waterlogged: "false" })
    put(4, 0, 0, "shulker_box", { facing: "up" })
    put(6, 0, 0, "red_banner", { rotation: "8" })
    put(8, 1, 0, "blue_wall_banner", { facing: "south" })
    return finish()
  }

  // billboarded technical icons: barrier, every light level, structure void
  if (kind === "billboard") {
    put(0, 0, 0, "barrier")
    for (let i = 0; i < 16; i++) put(1 + i, 0, 0, "light", { level: String(i) })
    put(17, 0, 0, "structure_void")
    return finish()
  }

  if (kind === "aquarium") {
    // glass tank: every translucent adjacency case at once
    for (let x = 0; x <= 6; x++) for (let z = 0; z <= 6; z++) put(x, 0, z, "grass_block")
    put(0, 1, 0, "dandelion")
    put(6, 1, 6, "dandelion")
    for (let x = 1; x <= 5; x++) for (let z = 1; z <= 5; z++) {
      const wall = x === 1 || x === 5 || z === 1 || z === 5
      put(x, 1, z, wall ? "glass" : "sand")
      for (const y of [2, 3]) {
        if (wall) put(x, y, z, "glass")
        else if (x === 3 && y === 2 && z === 3) put(x, y, z, "sea_pickle", { pickles: "4", waterlogged: "true" })
        else put(x, y, z, "water", { level: "0" })
      }
    }
    return finish()
  }

  // different models, same texture, coplanar 16x16 tops: should all merge
  put(0, 0, 0, "cobblestone"); put(1, 0, 0, "cobblestone_slab", { type: "double" })
  put(2, 0, 0, "cobblestone"); put(3, 0, 0, "cobblestone_slab", { type: "double" }); put(4, 0, 0, "cobblestone")
  run(2, "oak_slab", { type: "bottom" })
  run(4, "oak_slab", { type: "top" })
  run(6, "oak_stairs", { half: "bottom", facing: "east", shape: "straight" })
  // rotated logs (x,y,z) then a matching-axis pair that should merge
  put(0, 0, 8, "oak_log", { axis: "x" }); put(1, 0, 8, "oak_log", { axis: "y" }); put(2, 0, 8, "oak_log", { axis: "z" })
  put(4, 0, 8, "oak_log", { axis: "x" }); put(5, 0, 8, "oak_log", { axis: "x" })
  for (let i = 0; i < 3; i++) put(i * 2, 0, 10, "grass_block")
  for (let i = 0; i < 6; i++) put(i, 0, 12, i % 2 ? "cobblestone" : "oak_planks")
  for (let i = 0; i < 3; i++) put(i * 2, 0, 14, "glass")
  run(16, "cobblestone_wall", {}, 4)
  put(0, 0, 18, "oak_planks"); put(0, 1, 18, "oak_planks"); put(1, 0, 18, "oak_slab", { type: "bottom" })
  run(20, "dirt_path")
  put(0, 0, 22, "grass_block"); put(1, 0, 22, "dirt_path"); put(2, 0, 22, "grass_block")
  // fluids: source then flowing levels 1-7, surface sloping down the run
  for (let i = 0; i < 8; i++) put(i, 0, 24, "water", { level: String(i) })
  for (let i = 0; i < 8; i++) put(i, 0, 26, "lava", { level: String(i) })
  // same fluid above renders the lower block full; level 8 is falling
  put(9, 0, 24, "water", { level: "0" }); put(9, 1, 24, "water", { level: "0" })
  put(11, 0, 24, "water", { level: "8" })
  put(9, 0, 26, "lava", { level: "0" }); put(9, 1, 26, "lava", { level: "0" })
  put(0, 0, 30, "oak_slab", { type: "bottom", waterlogged: "true" })
  // same colour culls the shared face, different colours don't
  const glassCols = ["red", "orange", "yellow", "lime", "light_blue", "blue", "purple", "magenta"]
  for (let i = 0; i < glassCols.length; i++) {
    put(i, 0, 28, glassCols[i] + "_stained_glass")
    put(i, 1, 28, glassCols[i] + "_stained_glass")
  }
  return finish()
}
