import { HORIZ, rnd, shuffle } from "../transforms.js"

// ocean monument (OceanMonumentPieces): a full code port, one-shot. the
// building rolls a room graph on a 5x5(x3) grid, prunes connections while
// keeping everything reachable from the source room, then fits double/simple
// rooms over the unclaimed cells. postProcess order is the game's: building
// shell first, then child pieces in creation order, last write wins.
// generateWaterBox floods cells below sea level with water and carves air at
// or above it; there is no pre-existing ocean here so every flooded cell is
// emitted as a water block. fillColumnDown is capped at the piece floor (no
// terrain). the three elder guardians the wings and penthouse spawn ride
// along as entities.

// direction indices match Direction.get3DDataValue; opposite is i ^ 1
const DOWN = 0, UP = 1, NORTH = 2, SOUTH = 3, WEST = 4, EAST = 5
const STEPS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]

const BASE_GRAY = "minecraft:prismarine"
const BASE_LIGHT = "minecraft:prismarine_bricks"
const BASE_BLACK = "minecraft:dark_prismarine"
const DOT_DECO = BASE_LIGHT
const LAMP = "minecraft:sea_lantern"
const GOLD = "minecraft:gold_block"
const WATER = "minecraft:water"
const SPONGE = "minecraft:wet_sponge"
const AIR = "minecraft:air"
const SEA_LEVEL = 63

const getRoomIndex = (x, y, z) => y * 25 + z * 5 + x

const roomDef = index => ({
  index,
  connections: [null, null, null, null, null, null],
  hasOpening: [false, false, false, false, false, false],
  claimed: false, isSource: false, scanIndex: 0
})

function setConnection(room, dir, other) {
  room.connections[dir] = other
  other.connections[dir ^ 1] = room
}

function updateOpenings(room) {
  for (let i = 0; i < 6; i++) room.hasOpening[i] = room.connections[i] !== null
}

function findSource(room, scanIndex) {
  if (room.isSource) return true
  room.scanIndex = scanIndex
  for (let i = 0; i < 6; i++) {
    const c = room.connections[i]
    if (c && room.hasOpening[i] && c.scanIndex !== scanIndex && findSource(c, scanIndex)) return true
  }
  return false
}

const isSpecial = room => room.index >= 75
const countOpenings = room => room.hasOpening.reduce((n, o) => n + (o ? 1 : 0), 0)

function makeBox(x, y, z, dir, width, height, depth) {
  return dir === "north" || dir === "south"
    ? { minX: x, minY: y, minZ: z, maxX: x + width - 1, maxY: y + height - 1, maxZ: z + depth - 1 }
    : { minX: x, minY: y, minZ: z, maxX: x + depth - 1, maxY: y + height - 1, maxZ: z + width - 1 }
}

function moveBox(b, dx, dy, dz) {
  b.minX += dx; b.maxX += dx
  b.minY += dy; b.maxY += dy
  b.minZ += dz; b.maxZ += dz
}

function roomBox(dir, def, w, h, d) {
  const roomX = def.index % 5
  const roomZ = Math.floor(def.index / 5) % 5
  const roomY = Math.floor(def.index / 25)
  const box = makeBox(0, 0, 0, dir, w * 8, h * 4, d * 8)
  switch (dir) {
    case "north": moveBox(box, roomX * 8, roomY * 4, -(roomZ + d) * 8 + 1); break
    case "south": moveBox(box, roomX * 8, roomY * 4, roomZ * 8); break
    case "west": moveBox(box, -(roomZ + d) * 8 + 1, roomY * 4, roomX * 8); break
    default: moveBox(box, roomZ * 8, roomY * 4, roomX * 8)
  }
  return box
}

const boxFromCorners = (a, b) => ({
  minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), minZ: Math.min(a[2], b[2]),
  maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]), maxZ: Math.max(a[2], b[2])
})

// the default (seed 0) load aliases to a hand-picked layout: all three entry
// doorways open and every elder guardian room a short unblocked path away.
// seed 0 itself walls the entry off on two sides and buries one wing
const DEFAULT_SEED = 154

export async function runMonument(loadStruct, { maxDepth = Infinity, seed, stats } = {}) {
  const rand = rnd(seed === 0 ? DEFAULT_SEED : seed ?? (Math.random() * 0x100000000) >>> 0)
  const ni = n => Math.floor(rand() * n)

  const direction = HORIZ[ni(4)]
  const building = { dir: direction, box: makeBox(0, 39, 0, direction, 58, 23, 58) }

  const palette = [], palIdx = new Map()
  const stateFor = Name => {
    let i = palIdx.get(Name)
    if (i === undefined) {
      i = palette.length
      palette.push({ Name })
      palIdx.set(Name, i)
    }
    return i
  }
  const cells = new Map()
  const key = (x, y, z) => x + "," + y + "," + z

  // StructurePiece local -> world (setOrientation mirror/rotation only affects
  // block states, and every monument block is stateless, so positions suffice)
  const worldX = (p, x, z) => p.dir === "west" ? p.box.maxX - z : p.dir === "east" ? p.box.minX + z : p.box.minX + x
  const worldY = (p, y) => p.box.minY + y
  const worldZ = (p, x, z) => p.dir === "north" ? p.box.maxZ - z : p.dir === "south" ? p.box.minZ + z : p.box.minZ + x
  const getWorldPos = (p, x, y, z) => [worldX(p, x, z), worldY(p, y), worldZ(p, x, z)]

  function placeBlock(p, name, x, y, z) {
    const wx = worldX(p, x, z), wy = worldY(p, y), wz = worldZ(p, x, z)
    cells.set(key(wx, wy, wz), { state: stateFor(name), pos: [wx, wy, wz] })
  }

  function getBlockName(p, x, y, z) {
    const c = cells.get(key(worldX(p, x, z), worldY(p, y), worldZ(p, x, z)))
    return c ? palette[c.state].Name : AIR
  }

  function generateBox(p, x0, y0, z0, x1, y1, z1, name) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) placeBlock(p, name, x, y, z)
  }

  function generateWaterBox(p, x0, y0, z0, x1, y1, z1) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (getBlockName(p, x, y, z) === WATER) continue
      placeBlock(p, worldY(p, y) >= SEA_LEVEL ? AIR : WATER, x, y, z)
    }
  }

  function generateBoxOnFillOnly(p, x0, y0, z0, x1, y1, z1, name) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (getBlockName(p, x, y, z) === WATER) placeBlock(p, name, x, y, z)
    }
  }

  function generateDefaultFloor(p, xOff, zOff, downOpening) {
    if (downOpening) {
      generateBox(p, xOff + 0, 0, zOff + 0, xOff + 2, 0, zOff + 7, BASE_GRAY)
      generateBox(p, xOff + 5, 0, zOff + 0, xOff + 7, 0, zOff + 7, BASE_GRAY)
      generateBox(p, xOff + 3, 0, zOff + 0, xOff + 4, 0, zOff + 2, BASE_GRAY)
      generateBox(p, xOff + 3, 0, zOff + 5, xOff + 4, 0, zOff + 7, BASE_GRAY)
      generateBox(p, xOff + 3, 0, zOff + 2, xOff + 4, 0, zOff + 2, BASE_LIGHT)
      generateBox(p, xOff + 3, 0, zOff + 5, xOff + 4, 0, zOff + 5, BASE_LIGHT)
      generateBox(p, xOff + 2, 0, zOff + 3, xOff + 2, 0, zOff + 4, BASE_LIGHT)
      generateBox(p, xOff + 5, 0, zOff + 3, xOff + 5, 0, zOff + 4, BASE_LIGHT)
    } else {
      generateBox(p, xOff + 0, 0, zOff + 0, xOff + 7, 0, zOff + 7, BASE_GRAY)
    }
  }

  // ---- room graph

  function generateRoomGraph() {
    const roomGrid = new Array(75).fill(null)
    for (let x = 0; x < 5; x++) for (let z = 0; z < 4; z++) roomGrid[getRoomIndex(x, 0, z)] = roomDef(getRoomIndex(x, 0, z))
    for (let x = 0; x < 5; x++) for (let z = 0; z < 4; z++) roomGrid[getRoomIndex(x, 1, z)] = roomDef(getRoomIndex(x, 1, z))
    for (let x = 1; x < 4; x++) for (let z = 0; z < 2; z++) roomGrid[getRoomIndex(x, 2, z)] = roomDef(getRoomIndex(x, 2, z))
    const sourceRoom = roomGrid[getRoomIndex(2, 0, 0)]
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) for (let y = 0; y < 3; y++) {
      const pos = getRoomIndex(x, y, z)
      if (!roomGrid[pos]) continue
      for (let dir = 0; dir < 6; dir++) {
        const nx = x + STEPS[dir][0], ny = y + STEPS[dir][1], nz = z + STEPS[dir][2]
        if (nx < 0 || nx >= 5 || nz < 0 || nz >= 5 || ny < 0 || ny >= 3) continue
        const neigh = roomGrid[getRoomIndex(nx, ny, nz)]
        if (!neigh) continue
        // the game flips the direction for z-axis neighbours, so "north"
        // connections point to grid z + 1
        if (nz === z) setConnection(roomGrid[pos], dir, neigh)
        else setConnection(roomGrid[pos], dir ^ 1, neigh)
      }
    }
    const roofRoom = roomDef(1003)
    const leftWing = roomDef(1001)
    const rightWing = roomDef(1002)
    setConnection(roomGrid[getRoomIndex(2, 2, 0)], UP, roofRoom)
    setConnection(roomGrid[getRoomIndex(0, 1, 0)], SOUTH, leftWing)
    setConnection(roomGrid[getRoomIndex(4, 1, 0)], SOUTH, rightWing)
    roofRoom.claimed = true
    leftWing.claimed = true
    rightWing.claimed = true
    sourceRoom.isSource = true
    const coreRoom = roomGrid[getRoomIndex(ni(4), 0, 2)]
    coreRoom.claimed = true
    coreRoom.connections[EAST].claimed = true
    coreRoom.connections[NORTH].claimed = true
    coreRoom.connections[EAST].connections[NORTH].claimed = true
    coreRoom.connections[UP].claimed = true
    coreRoom.connections[EAST].connections[UP].claimed = true
    coreRoom.connections[NORTH].connections[UP].claimed = true
    coreRoom.connections[EAST].connections[NORTH].connections[UP].claimed = true
    let roomDefs = []
    for (const def of roomGrid) {
      if (def) {
        updateOpenings(def)
        roomDefs.push(def)
      }
    }
    updateOpenings(roofRoom)
    roomDefs = shuffle(roomDefs, rand)
    let scanIndex = 1
    for (const def of roomDefs) {
      let closeCount = 0, attemptCount = 0
      while (closeCount < 2 && attemptCount < 5) {
        attemptCount++
        const f = ni(6)
        if (!def.hasOpening[f]) continue
        const of = f ^ 1
        def.hasOpening[f] = false
        def.connections[f].hasOpening[of] = false
        if (findSource(def, scanIndex++) && findSource(def.connections[f], scanIndex++)) closeCount++
        else {
          def.hasOpening[f] = true
          def.connections[f].hasOpening[of] = true
        }
      }
    }
    roomDefs.push(roofRoom, leftWing, rightWing)
    return { roomDefs, sourceRoom, coreRoom }
  }

  const { roomDefs, sourceRoom, coreRoom } = generateRoomGraph()
  if (stats) {
    stats.sourceSides = [NORTH, WEST, EAST].filter(d => sourceRoom.hasOpening[d]).length
    stats.total = roomDefs.reduce((a, d) => a + d.hasOpening.filter(Boolean).length, 0)
    // breadth-first distances from the entry to the elder rooms (both wings
    // and the penthouse), through open doorways
    const dist = new Map([[sourceRoom, 0]])
    const queue = [sourceRoom]
    while (queue.length) {
      const def = queue.shift()
      for (let d = 0; d < 6; d++) {
        const next = def.connections[d]
        if (def.hasOpening[d] && next && !dist.has(next)) {
          dist.set(next, dist.get(def) + 1)
          queue.push(next)
        }
      }
    }
    stats.elders = roomDefs.filter(d => d.index >= 1001).map(d => dist.get(d) ?? Infinity)
  }
  sourceRoom.claimed = true

  const fitters = [
    { // FitDoubleXYRoom
      fits: d => d.hasOpening[EAST] && !d.connections[EAST].claimed
        && d.hasOpening[UP] && !d.connections[UP].claimed
        && d.connections[EAST].hasOpening[UP] && !d.connections[EAST].connections[UP].claimed,
      create: d => {
        d.claimed = true
        d.connections[EAST].claimed = true
        d.connections[UP].claimed = true
        d.connections[EAST].connections[UP].claimed = true
        return { kind: "doubleXY", dir: direction, def: d, box: roomBox(direction, d, 2, 2, 1) }
      }
    },
    { // FitDoubleYZRoom
      fits: d => d.hasOpening[NORTH] && !d.connections[NORTH].claimed
        && d.hasOpening[UP] && !d.connections[UP].claimed
        && d.connections[NORTH].hasOpening[UP] && !d.connections[NORTH].connections[UP].claimed,
      create: d => {
        d.claimed = true
        d.connections[NORTH].claimed = true
        d.connections[UP].claimed = true
        d.connections[NORTH].connections[UP].claimed = true
        return { kind: "doubleYZ", dir: direction, def: d, box: roomBox(direction, d, 1, 2, 2) }
      }
    },
    { // FitDoubleZRoom
      fits: d => d.hasOpening[NORTH] && !d.connections[NORTH].claimed,
      create: d => {
        let source = d
        if (!d.hasOpening[NORTH] || d.connections[NORTH].claimed) source = d.connections[SOUTH]
        source.claimed = true
        source.connections[NORTH].claimed = true
        return { kind: "doubleZ", dir: direction, def: source, box: roomBox(direction, source, 1, 1, 2) }
      }
    },
    { // FitDoubleXRoom
      fits: d => d.hasOpening[EAST] && !d.connections[EAST].claimed,
      create: d => {
        d.claimed = true
        d.connections[EAST].claimed = true
        return { kind: "doubleX", dir: direction, def: d, box: roomBox(direction, d, 2, 1, 1) }
      }
    },
    { // FitDoubleYRoom
      fits: d => d.hasOpening[UP] && !d.connections[UP].claimed,
      create: d => {
        d.claimed = true
        d.connections[UP].claimed = true
        return { kind: "doubleY", dir: direction, def: d, box: roomBox(direction, d, 1, 2, 1) }
      }
    },
    { // FitSimpleTopRoom
      fits: d => !d.hasOpening[WEST] && !d.hasOpening[EAST] && !d.hasOpening[NORTH] && !d.hasOpening[SOUTH] && !d.hasOpening[UP],
      create: d => {
        d.claimed = true
        return { kind: "simpleTop", dir: direction, def: d, box: roomBox(direction, d, 1, 1, 1) }
      }
    },
    { // FitSimpleRoom
      fits: () => true,
      create: d => {
        d.claimed = true
        return { kind: "simple", dir: direction, def: d, box: roomBox(direction, d, 1, 1, 1), mainDesign: ni(3) }
      }
    }
  ]

  const childPieces = []
  childPieces.push({ kind: "entry", dir: direction, def: sourceRoom, box: roomBox(direction, sourceRoom, 1, 1, 1) })
  childPieces.push({ kind: "core", dir: direction, def: coreRoom, box: roomBox(direction, coreRoom, 2, 2, 2) })
  for (const def of roomDefs) {
    if (def.claimed || isSpecial(def)) continue
    for (const fitter of fitters) {
      if (fitter.fits(def)) {
        childPieces.push(fitter.create(def))
        break
      }
    }
  }

  const [ox, oy, oz] = getWorldPos(building, 9, 0, 22)
  for (const child of childPieces) moveBox(child.box, ox, oy, oz)

  const leftWingBox = boxFromCorners(getWorldPos(building, 1, 1, 1), getWorldPos(building, 23, 8, 21))
  const rightWingBox = boxFromCorners(getWorldPos(building, 34, 1, 1), getWorldPos(building, 56, 8, 21))
  const penthouseBox = boxFromCorners(getWorldPos(building, 22, 13, 22), getWorldPos(building, 35, 17, 35))
  const wingRandom = ni(2)
  childPieces.push({ kind: "wing", dir: direction, box: leftWingBox, mainDesign: wingRandom & 1 })
  childPieces.push({ kind: "wing", dir: direction, box: rightWingBox, mainDesign: (wingRandom + 1) & 1 })
  childPieces.push({ kind: "penthouse", dir: direction, box: penthouseBox })

  // ---- building shell

  function generateWing(p, isFlipped, xoff) {
    generateBox(p, xoff + 0, 0, 0, xoff + 24, 0, 20, BASE_GRAY)
    generateWaterBox(p, xoff + 0, 1, 0, xoff + 24, 10, 20)
    for (let i = 0; i < 4; i++) {
      generateBox(p, xoff + i, i + 1, i, xoff + i, i + 1, 20, BASE_LIGHT)
      generateBox(p, xoff + i + 7, i + 5, i + 7, xoff + i + 7, i + 5, 20, BASE_LIGHT)
      generateBox(p, xoff + 17 - i, i + 5, i + 7, xoff + 17 - i, i + 5, 20, BASE_LIGHT)
      generateBox(p, xoff + 24 - i, i + 1, i, xoff + 24 - i, i + 1, 20, BASE_LIGHT)
      generateBox(p, xoff + i + 1, i + 1, i, xoff + 23 - i, i + 1, i, BASE_LIGHT)
      generateBox(p, xoff + i + 8, i + 5, i + 7, xoff + 16 - i, i + 5, i + 7, BASE_LIGHT)
    }
    generateBox(p, xoff + 4, 4, 4, xoff + 6, 4, 20, BASE_GRAY)
    generateBox(p, xoff + 7, 4, 4, xoff + 17, 4, 6, BASE_GRAY)
    generateBox(p, xoff + 18, 4, 4, xoff + 20, 4, 20, BASE_GRAY)
    generateBox(p, xoff + 11, 8, 11, xoff + 13, 8, 20, BASE_GRAY)
    placeBlock(p, DOT_DECO, xoff + 12, 9, 12)
    placeBlock(p, DOT_DECO, xoff + 12, 9, 15)
    placeBlock(p, DOT_DECO, xoff + 12, 9, 18)
    const leftPos = xoff + (isFlipped ? 19 : 5)
    const rightPos = xoff + (isFlipped ? 5 : 19)
    for (let z = 20; z >= 5; z -= 3) placeBlock(p, DOT_DECO, leftPos, 5, z)
    for (let z = 19; z >= 7; z -= 3) placeBlock(p, DOT_DECO, rightPos, 5, z)
    for (let i = 0; i < 4; i++) placeBlock(p, DOT_DECO, isFlipped ? xoff + 24 - (17 - i * 3) : xoff + 17 - i * 3, 5, 5)
    placeBlock(p, DOT_DECO, rightPos, 5, 5)
    generateBox(p, xoff + 11, 1, 12, xoff + 13, 7, 12, BASE_GRAY)
    generateBox(p, xoff + 12, 1, 11, xoff + 12, 7, 13, BASE_GRAY)
  }

  function generateEntranceArchs(p) {
    generateWaterBox(p, 25, 0, 0, 32, 8, 20)
    for (let i = 0; i < 4; i++) {
      generateBox(p, 24, 2, 5 + i * 4, 24, 4, 5 + i * 4, BASE_LIGHT)
      generateBox(p, 22, 4, 5 + i * 4, 23, 4, 5 + i * 4, BASE_LIGHT)
      placeBlock(p, BASE_LIGHT, 25, 5, 5 + i * 4)
      placeBlock(p, BASE_LIGHT, 26, 6, 5 + i * 4)
      placeBlock(p, LAMP, 26, 5, 5 + i * 4)
      generateBox(p, 33, 2, 5 + i * 4, 33, 4, 5 + i * 4, BASE_LIGHT)
      generateBox(p, 34, 4, 5 + i * 4, 35, 4, 5 + i * 4, BASE_LIGHT)
      placeBlock(p, BASE_LIGHT, 32, 5, 5 + i * 4)
      placeBlock(p, BASE_LIGHT, 31, 6, 5 + i * 4)
      placeBlock(p, LAMP, 31, 5, 5 + i * 4)
      generateBox(p, 27, 6, 5 + i * 4, 30, 6, 5 + i * 4, BASE_GRAY)
    }
  }

  function generateEntranceWall(p) {
    generateBox(p, 15, 0, 21, 42, 0, 21, BASE_GRAY)
    generateWaterBox(p, 26, 1, 21, 31, 3, 21)
    generateBox(p, 21, 12, 21, 36, 12, 21, BASE_GRAY)
    generateBox(p, 17, 11, 21, 40, 11, 21, BASE_GRAY)
    generateBox(p, 16, 10, 21, 41, 10, 21, BASE_GRAY)
    generateBox(p, 15, 7, 21, 42, 9, 21, BASE_GRAY)
    generateBox(p, 16, 6, 21, 41, 6, 21, BASE_GRAY)
    generateBox(p, 17, 5, 21, 40, 5, 21, BASE_GRAY)
    generateBox(p, 21, 4, 21, 36, 4, 21, BASE_GRAY)
    generateBox(p, 22, 3, 21, 26, 3, 21, BASE_GRAY)
    generateBox(p, 31, 3, 21, 35, 3, 21, BASE_GRAY)
    generateBox(p, 23, 2, 21, 25, 2, 21, BASE_GRAY)
    generateBox(p, 32, 2, 21, 34, 2, 21, BASE_GRAY)
    generateBox(p, 28, 4, 20, 29, 4, 21, BASE_LIGHT)
    placeBlock(p, BASE_LIGHT, 27, 3, 21)
    placeBlock(p, BASE_LIGHT, 30, 3, 21)
    placeBlock(p, BASE_LIGHT, 26, 2, 21)
    placeBlock(p, BASE_LIGHT, 31, 2, 21)
    placeBlock(p, BASE_LIGHT, 25, 1, 21)
    placeBlock(p, BASE_LIGHT, 32, 1, 21)
    for (let i = 0; i < 7; i++) {
      placeBlock(p, BASE_BLACK, 28 - i, 6 + i, 21)
      placeBlock(p, BASE_BLACK, 29 + i, 6 + i, 21)
    }
    for (let i = 0; i < 4; i++) {
      placeBlock(p, BASE_BLACK, 28 - i, 9 + i, 21)
      placeBlock(p, BASE_BLACK, 29 + i, 9 + i, 21)
    }
    placeBlock(p, BASE_BLACK, 28, 12, 21)
    placeBlock(p, BASE_BLACK, 29, 12, 21)
    for (let i = 0; i < 3; i++) {
      placeBlock(p, BASE_BLACK, 22 - i * 2, 8, 21)
      placeBlock(p, BASE_BLACK, 22 - i * 2, 9, 21)
      placeBlock(p, BASE_BLACK, 35 + i * 2, 8, 21)
      placeBlock(p, BASE_BLACK, 35 + i * 2, 9, 21)
    }
    generateWaterBox(p, 15, 13, 21, 42, 15, 21)
    generateWaterBox(p, 15, 1, 21, 15, 6, 21)
    generateWaterBox(p, 16, 1, 21, 16, 5, 21)
    generateWaterBox(p, 17, 1, 21, 20, 4, 21)
    generateWaterBox(p, 21, 1, 21, 21, 3, 21)
    generateWaterBox(p, 22, 1, 21, 22, 2, 21)
    generateWaterBox(p, 23, 1, 21, 24, 1, 21)
    generateWaterBox(p, 42, 1, 21, 42, 6, 21)
    generateWaterBox(p, 41, 1, 21, 41, 5, 21)
    generateWaterBox(p, 37, 1, 21, 40, 4, 21)
    generateWaterBox(p, 36, 1, 21, 36, 3, 21)
    generateWaterBox(p, 33, 1, 21, 34, 1, 21)
    generateWaterBox(p, 35, 1, 21, 35, 2, 21)
  }

  function generateRoofPiece(p) {
    generateBox(p, 21, 0, 22, 36, 0, 36, BASE_GRAY)
    generateWaterBox(p, 21, 1, 22, 36, 23, 36)
    for (let i = 0; i < 4; i++) {
      generateBox(p, 21 + i, 13 + i, 21 + i, 36 - i, 13 + i, 21 + i, BASE_LIGHT)
      generateBox(p, 21 + i, 13 + i, 36 - i, 36 - i, 13 + i, 36 - i, BASE_LIGHT)
      generateBox(p, 21 + i, 13 + i, 22 + i, 21 + i, 13 + i, 35 - i, BASE_LIGHT)
      generateBox(p, 36 - i, 13 + i, 22 + i, 36 - i, 13 + i, 35 - i, BASE_LIGHT)
    }
    generateBox(p, 25, 16, 25, 32, 16, 32, BASE_GRAY)
    generateBox(p, 25, 17, 25, 25, 19, 25, BASE_LIGHT)
    generateBox(p, 32, 17, 25, 32, 19, 25, BASE_LIGHT)
    generateBox(p, 25, 17, 32, 25, 19, 32, BASE_LIGHT)
    generateBox(p, 32, 17, 32, 32, 19, 32, BASE_LIGHT)
    placeBlock(p, BASE_LIGHT, 26, 20, 26)
    placeBlock(p, BASE_LIGHT, 27, 21, 27)
    placeBlock(p, LAMP, 27, 20, 27)
    placeBlock(p, BASE_LIGHT, 26, 20, 31)
    placeBlock(p, BASE_LIGHT, 27, 21, 30)
    placeBlock(p, LAMP, 27, 20, 30)
    placeBlock(p, BASE_LIGHT, 31, 20, 31)
    placeBlock(p, BASE_LIGHT, 30, 21, 30)
    placeBlock(p, LAMP, 30, 20, 30)
    placeBlock(p, BASE_LIGHT, 31, 20, 26)
    placeBlock(p, BASE_LIGHT, 30, 21, 27)
    placeBlock(p, LAMP, 30, 20, 27)
    generateBox(p, 28, 21, 27, 29, 21, 27, BASE_GRAY)
    generateBox(p, 27, 21, 28, 27, 21, 29, BASE_GRAY)
    generateBox(p, 28, 21, 30, 29, 21, 30, BASE_GRAY)
    generateBox(p, 30, 21, 28, 30, 21, 29, BASE_GRAY)
  }

  function generateLowerWall(p) {
    generateBox(p, 0, 0, 21, 6, 0, 57, BASE_GRAY)
    generateWaterBox(p, 0, 1, 21, 6, 7, 57)
    generateBox(p, 4, 4, 21, 6, 4, 53, BASE_GRAY)
    for (let i = 0; i < 4; i++) generateBox(p, i, i + 1, 21, i, i + 1, 57 - i, BASE_LIGHT)
    for (let z = 23; z < 53; z += 3) placeBlock(p, DOT_DECO, 5, 5, z)
    placeBlock(p, DOT_DECO, 5, 5, 52)
    for (let i = 0; i < 4; i++) generateBox(p, i, i + 1, 21, i, i + 1, 57 - i, BASE_LIGHT)
    generateBox(p, 4, 1, 52, 6, 3, 52, BASE_GRAY)
    generateBox(p, 5, 1, 51, 5, 3, 53, BASE_GRAY)

    generateBox(p, 51, 0, 21, 57, 0, 57, BASE_GRAY)
    generateWaterBox(p, 51, 1, 21, 57, 7, 57)
    generateBox(p, 51, 4, 21, 53, 4, 53, BASE_GRAY)
    for (let i = 0; i < 4; i++) generateBox(p, 57 - i, i + 1, 21, 57 - i, i + 1, 57 - i, BASE_LIGHT)
    for (let z = 23; z < 53; z += 3) placeBlock(p, DOT_DECO, 52, 5, z)
    placeBlock(p, DOT_DECO, 52, 5, 52)
    generateBox(p, 51, 1, 52, 53, 3, 52, BASE_GRAY)
    generateBox(p, 52, 1, 51, 52, 3, 53, BASE_GRAY)

    generateBox(p, 7, 0, 51, 50, 0, 57, BASE_GRAY)
    generateWaterBox(p, 7, 1, 51, 50, 10, 57)
    for (let i = 0; i < 4; i++) generateBox(p, i + 1, i + 1, 57 - i, 56 - i, i + 1, 57 - i, BASE_LIGHT)
  }

  function generateMiddleWall(p) {
    generateBox(p, 7, 0, 21, 13, 0, 50, BASE_GRAY)
    generateWaterBox(p, 7, 1, 21, 13, 10, 50)
    generateBox(p, 11, 8, 21, 13, 8, 53, BASE_GRAY)
    for (let i = 0; i < 4; i++) generateBox(p, i + 7, i + 5, 21, i + 7, i + 5, 54, BASE_LIGHT)
    for (let z = 21; z <= 45; z += 3) placeBlock(p, DOT_DECO, 12, 9, z)

    generateBox(p, 44, 0, 21, 50, 0, 50, BASE_GRAY)
    generateWaterBox(p, 44, 1, 21, 50, 10, 50)
    generateBox(p, 44, 8, 21, 46, 8, 53, BASE_GRAY)
    for (let i = 0; i < 4; i++) generateBox(p, 50 - i, i + 5, 21, 50 - i, i + 5, 54, BASE_LIGHT)
    for (let z = 21; z <= 45; z += 3) placeBlock(p, DOT_DECO, 45, 9, z)

    generateBox(p, 14, 0, 44, 43, 0, 50, BASE_GRAY)
    generateWaterBox(p, 14, 1, 44, 43, 10, 50)
    for (let x = 12; x <= 45; x += 3) {
      placeBlock(p, DOT_DECO, x, 9, 45)
      placeBlock(p, DOT_DECO, x, 9, 52)
      if (x === 12 || x === 18 || x === 24 || x === 33 || x === 39 || x === 45) {
        placeBlock(p, DOT_DECO, x, 9, 47)
        placeBlock(p, DOT_DECO, x, 9, 50)
        placeBlock(p, DOT_DECO, x, 10, 45)
        placeBlock(p, DOT_DECO, x, 10, 46)
        placeBlock(p, DOT_DECO, x, 10, 51)
        placeBlock(p, DOT_DECO, x, 10, 52)
        placeBlock(p, DOT_DECO, x, 11, 47)
        placeBlock(p, DOT_DECO, x, 11, 50)
        placeBlock(p, DOT_DECO, x, 12, 48)
        placeBlock(p, DOT_DECO, x, 12, 49)
      }
    }
    for (let i = 0; i < 3; i++) generateBox(p, 8 + i, 5 + i, 54, 49 - i, 5 + i, 54, BASE_GRAY)
    generateBox(p, 11, 8, 54, 46, 8, 54, BASE_LIGHT)
    generateBox(p, 14, 8, 44, 43, 8, 53, BASE_GRAY)
  }

  function generateUpperWall(p) {
    generateBox(p, 14, 0, 21, 20, 0, 43, BASE_GRAY)
    generateWaterBox(p, 14, 1, 22, 20, 14, 43)
    generateBox(p, 18, 12, 22, 20, 12, 39, BASE_GRAY)
    generateBox(p, 18, 12, 21, 20, 12, 21, BASE_LIGHT)
    for (let i = 0; i < 4; i++) generateBox(p, i + 14, i + 9, 21, i + 14, i + 9, 43 - i, BASE_LIGHT)
    for (let z = 23; z <= 39; z += 3) placeBlock(p, DOT_DECO, 19, 13, z)

    generateBox(p, 37, 0, 21, 43, 0, 43, BASE_GRAY)
    generateWaterBox(p, 37, 1, 22, 43, 14, 43)
    generateBox(p, 37, 12, 22, 39, 12, 39, BASE_GRAY)
    generateBox(p, 37, 12, 21, 39, 12, 21, BASE_LIGHT)
    for (let i = 0; i < 4; i++) generateBox(p, 43 - i, i + 9, 21, 43 - i, i + 9, 43 - i, BASE_LIGHT)
    for (let z = 23; z <= 39; z += 3) placeBlock(p, DOT_DECO, 38, 13, z)

    generateBox(p, 21, 0, 37, 36, 0, 43, BASE_GRAY)
    generateWaterBox(p, 21, 1, 37, 36, 14, 43)
    generateBox(p, 21, 12, 37, 36, 12, 39, BASE_GRAY)
    for (let i = 0; i < 4; i++) generateBox(p, 15 + i, i + 9, 43 - i, 42 - i, i + 9, 43 - i, BASE_LIGHT)
    for (let x = 21; x <= 36; x += 3) placeBlock(p, DOT_DECO, x, 13, 38)
  }

  // ---- child room pieces

  function entryPost(p) {
    generateBox(p, 0, 3, 0, 2, 3, 7, BASE_LIGHT)
    generateBox(p, 5, 3, 0, 7, 3, 7, BASE_LIGHT)
    generateBox(p, 0, 2, 0, 1, 2, 7, BASE_LIGHT)
    generateBox(p, 6, 2, 0, 7, 2, 7, BASE_LIGHT)
    generateBox(p, 0, 1, 0, 0, 1, 7, BASE_LIGHT)
    generateBox(p, 7, 1, 0, 7, 1, 7, BASE_LIGHT)
    generateBox(p, 0, 1, 7, 7, 3, 7, BASE_LIGHT)
    generateBox(p, 1, 1, 0, 2, 3, 0, BASE_LIGHT)
    generateBox(p, 5, 1, 0, 6, 3, 0, BASE_LIGHT)
    if (p.def.hasOpening[NORTH]) generateWaterBox(p, 3, 1, 7, 4, 2, 7)
    if (p.def.hasOpening[WEST]) generateWaterBox(p, 0, 1, 3, 1, 2, 4)
    if (p.def.hasOpening[EAST]) generateWaterBox(p, 6, 1, 3, 7, 2, 4)
  }

  function corePost(p) {
    generateBoxOnFillOnly(p, 1, 8, 0, 14, 8, 14, BASE_GRAY)
    generateBox(p, 0, 7, 0, 0, 7, 15, BASE_LIGHT)
    generateBox(p, 15, 7, 0, 15, 7, 15, BASE_LIGHT)
    generateBox(p, 1, 7, 0, 15, 7, 0, BASE_LIGHT)
    generateBox(p, 1, 7, 15, 14, 7, 15, BASE_LIGHT)
    for (let y = 1; y <= 6; y++) {
      const block = y === 2 || y === 6 ? BASE_GRAY : BASE_LIGHT
      for (let x = 0; x <= 15; x += 15) {
        generateBox(p, x, y, 0, x, y, 1, block)
        generateBox(p, x, y, 6, x, y, 9, block)
        generateBox(p, x, y, 14, x, y, 15, block)
      }
      generateBox(p, 1, y, 0, 1, y, 0, block)
      generateBox(p, 6, y, 0, 9, y, 0, block)
      generateBox(p, 14, y, 0, 14, y, 0, block)
      generateBox(p, 1, y, 15, 14, y, 15, block)
    }
    generateBox(p, 6, 3, 6, 9, 6, 9, BASE_BLACK)
    generateBox(p, 7, 4, 7, 8, 5, 8, GOLD)
    for (let y = 3; y <= 6; y += 3) for (let x = 6; x <= 9; x += 3) {
      placeBlock(p, LAMP, x, y, 6)
      placeBlock(p, LAMP, x, y, 9)
    }
    generateBox(p, 5, 1, 6, 5, 2, 6, BASE_LIGHT)
    generateBox(p, 5, 1, 9, 5, 2, 9, BASE_LIGHT)
    generateBox(p, 10, 1, 6, 10, 2, 6, BASE_LIGHT)
    generateBox(p, 10, 1, 9, 10, 2, 9, BASE_LIGHT)
    generateBox(p, 6, 1, 5, 6, 2, 5, BASE_LIGHT)
    generateBox(p, 9, 1, 5, 9, 2, 5, BASE_LIGHT)
    generateBox(p, 6, 1, 10, 6, 2, 10, BASE_LIGHT)
    generateBox(p, 9, 1, 10, 9, 2, 10, BASE_LIGHT)
    generateBox(p, 5, 2, 5, 5, 6, 5, BASE_LIGHT)
    generateBox(p, 5, 2, 10, 5, 6, 10, BASE_LIGHT)
    generateBox(p, 10, 2, 5, 10, 6, 5, BASE_LIGHT)
    generateBox(p, 10, 2, 10, 10, 6, 10, BASE_LIGHT)
    generateBox(p, 5, 7, 1, 5, 7, 6, BASE_LIGHT)
    generateBox(p, 10, 7, 1, 10, 7, 6, BASE_LIGHT)
    generateBox(p, 5, 7, 9, 5, 7, 14, BASE_LIGHT)
    generateBox(p, 10, 7, 9, 10, 7, 14, BASE_LIGHT)
    generateBox(p, 1, 7, 5, 6, 7, 5, BASE_LIGHT)
    generateBox(p, 1, 7, 10, 6, 7, 10, BASE_LIGHT)
    generateBox(p, 9, 7, 5, 14, 7, 5, BASE_LIGHT)
    generateBox(p, 9, 7, 10, 14, 7, 10, BASE_LIGHT)
    generateBox(p, 2, 1, 2, 2, 1, 3, BASE_LIGHT)
    generateBox(p, 3, 1, 2, 3, 1, 2, BASE_LIGHT)
    generateBox(p, 13, 1, 2, 13, 1, 3, BASE_LIGHT)
    generateBox(p, 12, 1, 2, 12, 1, 2, BASE_LIGHT)
    generateBox(p, 2, 1, 12, 2, 1, 13, BASE_LIGHT)
    generateBox(p, 3, 1, 13, 3, 1, 13, BASE_LIGHT)
    generateBox(p, 13, 1, 12, 13, 1, 13, BASE_LIGHT)
    generateBox(p, 12, 1, 13, 12, 1, 13, BASE_LIGHT)
  }

  function doubleXPost(p) {
    const east = p.def.connections[EAST]
    const west = p.def
    if (Math.floor(p.def.index / 25) > 0) {
      generateDefaultFloor(p, 8, 0, east.hasOpening[DOWN])
      generateDefaultFloor(p, 0, 0, west.hasOpening[DOWN])
    }
    if (!west.connections[UP]) generateBoxOnFillOnly(p, 1, 4, 1, 7, 4, 6, BASE_GRAY)
    if (!east.connections[UP]) generateBoxOnFillOnly(p, 8, 4, 1, 14, 4, 6, BASE_GRAY)
    generateBox(p, 0, 3, 0, 0, 3, 7, BASE_LIGHT)
    generateBox(p, 15, 3, 0, 15, 3, 7, BASE_LIGHT)
    generateBox(p, 1, 3, 0, 15, 3, 0, BASE_LIGHT)
    generateBox(p, 1, 3, 7, 14, 3, 7, BASE_LIGHT)
    generateBox(p, 0, 2, 0, 0, 2, 7, BASE_GRAY)
    generateBox(p, 15, 2, 0, 15, 2, 7, BASE_GRAY)
    generateBox(p, 1, 2, 0, 15, 2, 0, BASE_GRAY)
    generateBox(p, 1, 2, 7, 14, 2, 7, BASE_GRAY)
    generateBox(p, 0, 1, 0, 0, 1, 7, BASE_LIGHT)
    generateBox(p, 15, 1, 0, 15, 1, 7, BASE_LIGHT)
    generateBox(p, 1, 1, 0, 15, 1, 0, BASE_LIGHT)
    generateBox(p, 1, 1, 7, 14, 1, 7, BASE_LIGHT)
    generateBox(p, 5, 1, 0, 10, 1, 4, BASE_LIGHT)
    generateBox(p, 6, 2, 0, 9, 2, 3, BASE_GRAY)
    generateBox(p, 5, 3, 0, 10, 3, 4, BASE_LIGHT)
    placeBlock(p, LAMP, 6, 2, 3)
    placeBlock(p, LAMP, 9, 2, 3)
    if (west.hasOpening[SOUTH]) generateWaterBox(p, 3, 1, 0, 4, 2, 0)
    if (west.hasOpening[NORTH]) generateWaterBox(p, 3, 1, 7, 4, 2, 7)
    if (west.hasOpening[WEST]) generateWaterBox(p, 0, 1, 3, 0, 2, 4)
    if (east.hasOpening[SOUTH]) generateWaterBox(p, 11, 1, 0, 12, 2, 0)
    if (east.hasOpening[NORTH]) generateWaterBox(p, 11, 1, 7, 12, 2, 7)
    if (east.hasOpening[EAST]) generateWaterBox(p, 15, 1, 3, 15, 2, 4)
  }

  function doubleXYPost(p) {
    const east = p.def.connections[EAST]
    const west = p.def
    const westUp = west.connections[UP]
    const eastUp = east.connections[UP]
    if (Math.floor(p.def.index / 25) > 0) {
      generateDefaultFloor(p, 8, 0, east.hasOpening[DOWN])
      generateDefaultFloor(p, 0, 0, west.hasOpening[DOWN])
    }
    if (!westUp.connections[UP]) generateBoxOnFillOnly(p, 1, 8, 1, 7, 8, 6, BASE_GRAY)
    if (!eastUp.connections[UP]) generateBoxOnFillOnly(p, 8, 8, 1, 14, 8, 6, BASE_GRAY)
    for (let y = 1; y <= 7; y++) {
      const block = y === 2 || y === 6 ? BASE_GRAY : BASE_LIGHT
      generateBox(p, 0, y, 0, 0, y, 7, block)
      generateBox(p, 15, y, 0, 15, y, 7, block)
      generateBox(p, 1, y, 0, 15, y, 0, block)
      generateBox(p, 1, y, 7, 14, y, 7, block)
    }
    generateBox(p, 2, 1, 3, 2, 7, 4, BASE_LIGHT)
    generateBox(p, 3, 1, 2, 4, 7, 2, BASE_LIGHT)
    generateBox(p, 3, 1, 5, 4, 7, 5, BASE_LIGHT)
    generateBox(p, 13, 1, 3, 13, 7, 4, BASE_LIGHT)
    generateBox(p, 11, 1, 2, 12, 7, 2, BASE_LIGHT)
    generateBox(p, 11, 1, 5, 12, 7, 5, BASE_LIGHT)
    generateBox(p, 5, 1, 3, 5, 3, 4, BASE_LIGHT)
    generateBox(p, 10, 1, 3, 10, 3, 4, BASE_LIGHT)
    generateBox(p, 5, 7, 2, 10, 7, 5, BASE_LIGHT)
    generateBox(p, 5, 5, 2, 5, 7, 2, BASE_LIGHT)
    generateBox(p, 10, 5, 2, 10, 7, 2, BASE_LIGHT)
    generateBox(p, 5, 5, 5, 5, 7, 5, BASE_LIGHT)
    generateBox(p, 10, 5, 5, 10, 7, 5, BASE_LIGHT)
    placeBlock(p, BASE_LIGHT, 6, 6, 2)
    placeBlock(p, BASE_LIGHT, 9, 6, 2)
    placeBlock(p, BASE_LIGHT, 6, 6, 5)
    placeBlock(p, BASE_LIGHT, 9, 6, 5)
    generateBox(p, 5, 4, 3, 6, 4, 4, BASE_LIGHT)
    generateBox(p, 9, 4, 3, 10, 4, 4, BASE_LIGHT)
    placeBlock(p, LAMP, 5, 4, 2)
    placeBlock(p, LAMP, 5, 4, 5)
    placeBlock(p, LAMP, 10, 4, 2)
    placeBlock(p, LAMP, 10, 4, 5)
    if (west.hasOpening[SOUTH]) generateWaterBox(p, 3, 1, 0, 4, 2, 0)
    if (west.hasOpening[NORTH]) generateWaterBox(p, 3, 1, 7, 4, 2, 7)
    if (west.hasOpening[WEST]) generateWaterBox(p, 0, 1, 3, 0, 2, 4)
    if (east.hasOpening[SOUTH]) generateWaterBox(p, 11, 1, 0, 12, 2, 0)
    if (east.hasOpening[NORTH]) generateWaterBox(p, 11, 1, 7, 12, 2, 7)
    if (east.hasOpening[EAST]) generateWaterBox(p, 15, 1, 3, 15, 2, 4)
    if (westUp.hasOpening[SOUTH]) generateWaterBox(p, 3, 5, 0, 4, 6, 0)
    if (westUp.hasOpening[NORTH]) generateWaterBox(p, 3, 5, 7, 4, 6, 7)
    if (westUp.hasOpening[WEST]) generateWaterBox(p, 0, 5, 3, 0, 6, 4)
    if (eastUp.hasOpening[SOUTH]) generateWaterBox(p, 11, 5, 0, 12, 6, 0)
    if (eastUp.hasOpening[NORTH]) generateWaterBox(p, 11, 5, 7, 12, 6, 7)
    if (eastUp.hasOpening[EAST]) generateWaterBox(p, 15, 5, 3, 15, 6, 4)
  }

  function doubleYPost(p) {
    if (Math.floor(p.def.index / 25) > 0) generateDefaultFloor(p, 0, 0, p.def.hasOpening[DOWN])
    const above = p.def.connections[UP]
    if (!above.connections[UP]) generateBoxOnFillOnly(p, 1, 8, 1, 6, 8, 6, BASE_GRAY)
    generateBox(p, 0, 4, 0, 0, 4, 7, BASE_LIGHT)
    generateBox(p, 7, 4, 0, 7, 4, 7, BASE_LIGHT)
    generateBox(p, 1, 4, 0, 6, 4, 0, BASE_LIGHT)
    generateBox(p, 1, 4, 7, 6, 4, 7, BASE_LIGHT)
    generateBox(p, 2, 4, 1, 2, 4, 2, BASE_LIGHT)
    generateBox(p, 1, 4, 2, 1, 4, 2, BASE_LIGHT)
    generateBox(p, 5, 4, 1, 5, 4, 2, BASE_LIGHT)
    generateBox(p, 6, 4, 2, 6, 4, 2, BASE_LIGHT)
    generateBox(p, 2, 4, 5, 2, 4, 6, BASE_LIGHT)
    generateBox(p, 1, 4, 5, 1, 4, 5, BASE_LIGHT)
    generateBox(p, 5, 4, 5, 5, 4, 6, BASE_LIGHT)
    generateBox(p, 6, 4, 5, 6, 4, 5, BASE_LIGHT)
    let def = p.def
    for (let y = 1; y <= 5; y += 4) {
      if (def.hasOpening[SOUTH]) {
        generateBox(p, 2, y, 0, 2, y + 2, 0, BASE_LIGHT)
        generateBox(p, 5, y, 0, 5, y + 2, 0, BASE_LIGHT)
        generateBox(p, 3, y + 2, 0, 4, y + 2, 0, BASE_LIGHT)
      } else {
        generateBox(p, 0, y, 0, 7, y + 2, 0, BASE_LIGHT)
        generateBox(p, 0, y + 1, 0, 7, y + 1, 0, BASE_GRAY)
      }
      if (def.hasOpening[NORTH]) {
        generateBox(p, 2, y, 7, 2, y + 2, 7, BASE_LIGHT)
        generateBox(p, 5, y, 7, 5, y + 2, 7, BASE_LIGHT)
        generateBox(p, 3, y + 2, 7, 4, y + 2, 7, BASE_LIGHT)
      } else {
        generateBox(p, 0, y, 7, 7, y + 2, 7, BASE_LIGHT)
        generateBox(p, 0, y + 1, 7, 7, y + 1, 7, BASE_GRAY)
      }
      if (def.hasOpening[WEST]) {
        generateBox(p, 0, y, 2, 0, y + 2, 2, BASE_LIGHT)
        generateBox(p, 0, y, 5, 0, y + 2, 5, BASE_LIGHT)
        generateBox(p, 0, y + 2, 3, 0, y + 2, 4, BASE_LIGHT)
      } else {
        generateBox(p, 0, y, 0, 0, y + 2, 7, BASE_LIGHT)
        generateBox(p, 0, y + 1, 0, 0, y + 1, 7, BASE_GRAY)
      }
      if (def.hasOpening[EAST]) {
        generateBox(p, 7, y, 2, 7, y + 2, 2, BASE_LIGHT)
        generateBox(p, 7, y, 5, 7, y + 2, 5, BASE_LIGHT)
        generateBox(p, 7, y + 2, 3, 7, y + 2, 4, BASE_LIGHT)
      } else {
        generateBox(p, 7, y, 0, 7, y + 2, 7, BASE_LIGHT)
        generateBox(p, 7, y + 1, 0, 7, y + 1, 7, BASE_GRAY)
      }
      def = above
    }
  }

  function doubleYZPost(p) {
    const north = p.def.connections[NORTH]
    const south = p.def
    const northUp = north.connections[UP]
    const southUp = south.connections[UP]
    if (Math.floor(p.def.index / 25) > 0) {
      generateDefaultFloor(p, 0, 8, north.hasOpening[DOWN])
      generateDefaultFloor(p, 0, 0, south.hasOpening[DOWN])
    }
    if (!southUp.connections[UP]) generateBoxOnFillOnly(p, 1, 8, 1, 6, 8, 7, BASE_GRAY)
    if (!northUp.connections[UP]) generateBoxOnFillOnly(p, 1, 8, 8, 6, 8, 14, BASE_GRAY)
    for (let y = 1; y <= 7; y++) {
      const block = y === 2 || y === 6 ? BASE_GRAY : BASE_LIGHT
      generateBox(p, 0, y, 0, 0, y, 15, block)
      generateBox(p, 7, y, 0, 7, y, 15, block)
      generateBox(p, 1, y, 0, 6, y, 0, block)
      generateBox(p, 1, y, 15, 6, y, 15, block)
    }
    for (let y = 1; y <= 7; y++) {
      const block = y === 2 || y === 6 ? LAMP : BASE_BLACK
      generateBox(p, 3, y, 7, 4, y, 8, block)
    }
    if (south.hasOpening[SOUTH]) generateWaterBox(p, 3, 1, 0, 4, 2, 0)
    if (south.hasOpening[EAST]) generateWaterBox(p, 7, 1, 3, 7, 2, 4)
    if (south.hasOpening[WEST]) generateWaterBox(p, 0, 1, 3, 0, 2, 4)
    if (north.hasOpening[NORTH]) generateWaterBox(p, 3, 1, 15, 4, 2, 15)
    if (north.hasOpening[WEST]) generateWaterBox(p, 0, 1, 11, 0, 2, 12)
    if (north.hasOpening[EAST]) generateWaterBox(p, 7, 1, 11, 7, 2, 12)
    if (southUp.hasOpening[SOUTH]) generateWaterBox(p, 3, 5, 0, 4, 6, 0)
    if (southUp.hasOpening[EAST]) {
      generateWaterBox(p, 7, 5, 3, 7, 6, 4)
      generateBox(p, 5, 4, 2, 6, 4, 5, BASE_LIGHT)
      generateBox(p, 6, 1, 2, 6, 3, 2, BASE_LIGHT)
      generateBox(p, 6, 1, 5, 6, 3, 5, BASE_LIGHT)
    }
    if (southUp.hasOpening[WEST]) {
      generateWaterBox(p, 0, 5, 3, 0, 6, 4)
      generateBox(p, 1, 4, 2, 2, 4, 5, BASE_LIGHT)
      generateBox(p, 1, 1, 2, 1, 3, 2, BASE_LIGHT)
      generateBox(p, 1, 1, 5, 1, 3, 5, BASE_LIGHT)
    }
    if (northUp.hasOpening[NORTH]) generateWaterBox(p, 3, 5, 15, 4, 6, 15)
    if (northUp.hasOpening[WEST]) {
      generateWaterBox(p, 0, 5, 11, 0, 6, 12)
      generateBox(p, 1, 4, 10, 2, 4, 13, BASE_LIGHT)
      generateBox(p, 1, 1, 10, 1, 3, 10, BASE_LIGHT)
      generateBox(p, 1, 1, 13, 1, 3, 13, BASE_LIGHT)
    }
    if (northUp.hasOpening[EAST]) {
      generateWaterBox(p, 7, 5, 11, 7, 6, 12)
      generateBox(p, 5, 4, 10, 6, 4, 13, BASE_LIGHT)
      generateBox(p, 6, 1, 10, 6, 3, 10, BASE_LIGHT)
      generateBox(p, 6, 1, 13, 6, 3, 13, BASE_LIGHT)
    }
  }

  function doubleZPost(p) {
    const north = p.def.connections[NORTH]
    const south = p.def
    if (Math.floor(p.def.index / 25) > 0) {
      generateDefaultFloor(p, 0, 8, north.hasOpening[DOWN])
      generateDefaultFloor(p, 0, 0, south.hasOpening[DOWN])
    }
    if (!south.connections[UP]) generateBoxOnFillOnly(p, 1, 4, 1, 6, 4, 7, BASE_GRAY)
    if (!north.connections[UP]) generateBoxOnFillOnly(p, 1, 4, 8, 6, 4, 14, BASE_GRAY)
    generateBox(p, 0, 3, 0, 0, 3, 15, BASE_LIGHT)
    generateBox(p, 7, 3, 0, 7, 3, 15, BASE_LIGHT)
    generateBox(p, 1, 3, 0, 7, 3, 0, BASE_LIGHT)
    generateBox(p, 1, 3, 15, 6, 3, 15, BASE_LIGHT)
    generateBox(p, 0, 2, 0, 0, 2, 15, BASE_GRAY)
    generateBox(p, 7, 2, 0, 7, 2, 15, BASE_GRAY)
    generateBox(p, 1, 2, 0, 7, 2, 0, BASE_GRAY)
    generateBox(p, 1, 2, 15, 6, 2, 15, BASE_GRAY)
    generateBox(p, 0, 1, 0, 0, 1, 15, BASE_LIGHT)
    generateBox(p, 7, 1, 0, 7, 1, 15, BASE_LIGHT)
    generateBox(p, 1, 1, 0, 7, 1, 0, BASE_LIGHT)
    generateBox(p, 1, 1, 15, 6, 1, 15, BASE_LIGHT)
    generateBox(p, 1, 1, 1, 1, 1, 2, BASE_LIGHT)
    generateBox(p, 6, 1, 1, 6, 1, 2, BASE_LIGHT)
    generateBox(p, 1, 3, 1, 1, 3, 2, BASE_LIGHT)
    generateBox(p, 6, 3, 1, 6, 3, 2, BASE_LIGHT)
    generateBox(p, 1, 1, 13, 1, 1, 14, BASE_LIGHT)
    generateBox(p, 6, 1, 13, 6, 1, 14, BASE_LIGHT)
    generateBox(p, 1, 3, 13, 1, 3, 14, BASE_LIGHT)
    generateBox(p, 6, 3, 13, 6, 3, 14, BASE_LIGHT)
    generateBox(p, 2, 1, 6, 2, 3, 6, BASE_LIGHT)
    generateBox(p, 5, 1, 6, 5, 3, 6, BASE_LIGHT)
    generateBox(p, 2, 1, 9, 2, 3, 9, BASE_LIGHT)
    generateBox(p, 5, 1, 9, 5, 3, 9, BASE_LIGHT)
    generateBox(p, 3, 2, 6, 4, 2, 6, BASE_LIGHT)
    generateBox(p, 3, 2, 9, 4, 2, 9, BASE_LIGHT)
    generateBox(p, 2, 2, 7, 2, 2, 8, BASE_LIGHT)
    generateBox(p, 5, 2, 7, 5, 2, 8, BASE_LIGHT)
    placeBlock(p, LAMP, 2, 2, 5)
    placeBlock(p, LAMP, 5, 2, 5)
    placeBlock(p, LAMP, 2, 2, 10)
    placeBlock(p, LAMP, 5, 2, 10)
    placeBlock(p, BASE_LIGHT, 2, 3, 5)
    placeBlock(p, BASE_LIGHT, 5, 3, 5)
    placeBlock(p, BASE_LIGHT, 2, 3, 10)
    placeBlock(p, BASE_LIGHT, 5, 3, 10)
    if (south.hasOpening[SOUTH]) generateWaterBox(p, 3, 1, 0, 4, 2, 0)
    if (south.hasOpening[EAST]) generateWaterBox(p, 7, 1, 3, 7, 2, 4)
    if (south.hasOpening[WEST]) generateWaterBox(p, 0, 1, 3, 0, 2, 4)
    if (north.hasOpening[NORTH]) generateWaterBox(p, 3, 1, 15, 4, 2, 15)
    if (north.hasOpening[WEST]) generateWaterBox(p, 0, 1, 11, 0, 2, 12)
    if (north.hasOpening[EAST]) generateWaterBox(p, 7, 1, 11, 7, 2, 12)
  }

  function simplePost(p) {
    const def = p.def
    if (Math.floor(def.index / 25) > 0) generateDefaultFloor(p, 0, 0, def.hasOpening[DOWN])
    if (!def.connections[UP]) generateBoxOnFillOnly(p, 1, 4, 1, 6, 4, 6, BASE_GRAY)
    const centerPillar = p.mainDesign !== 0
      && rand() < 0.5
      && !def.hasOpening[DOWN]
      && !def.hasOpening[UP]
      && countOpenings(def) > 1
    if (p.mainDesign === 0) {
      generateBox(p, 0, 1, 0, 2, 1, 2, BASE_LIGHT)
      generateBox(p, 0, 3, 0, 2, 3, 2, BASE_LIGHT)
      generateBox(p, 0, 2, 0, 0, 2, 2, BASE_GRAY)
      generateBox(p, 1, 2, 0, 2, 2, 0, BASE_GRAY)
      placeBlock(p, LAMP, 1, 2, 1)
      generateBox(p, 5, 1, 0, 7, 1, 2, BASE_LIGHT)
      generateBox(p, 5, 3, 0, 7, 3, 2, BASE_LIGHT)
      generateBox(p, 7, 2, 0, 7, 2, 2, BASE_GRAY)
      generateBox(p, 5, 2, 0, 6, 2, 0, BASE_GRAY)
      placeBlock(p, LAMP, 6, 2, 1)
      generateBox(p, 0, 1, 5, 2, 1, 7, BASE_LIGHT)
      generateBox(p, 0, 3, 5, 2, 3, 7, BASE_LIGHT)
      generateBox(p, 0, 2, 5, 0, 2, 7, BASE_GRAY)
      generateBox(p, 1, 2, 7, 2, 2, 7, BASE_GRAY)
      placeBlock(p, LAMP, 1, 2, 6)
      generateBox(p, 5, 1, 5, 7, 1, 7, BASE_LIGHT)
      generateBox(p, 5, 3, 5, 7, 3, 7, BASE_LIGHT)
      generateBox(p, 7, 2, 5, 7, 2, 7, BASE_GRAY)
      generateBox(p, 5, 2, 7, 6, 2, 7, BASE_GRAY)
      placeBlock(p, LAMP, 6, 2, 6)
      if (def.hasOpening[SOUTH]) {
        generateBox(p, 3, 3, 0, 4, 3, 0, BASE_LIGHT)
      } else {
        generateBox(p, 3, 3, 0, 4, 3, 1, BASE_LIGHT)
        generateBox(p, 3, 2, 0, 4, 2, 0, BASE_GRAY)
        generateBox(p, 3, 1, 0, 4, 1, 1, BASE_LIGHT)
      }
      if (def.hasOpening[NORTH]) {
        generateBox(p, 3, 3, 7, 4, 3, 7, BASE_LIGHT)
      } else {
        generateBox(p, 3, 3, 6, 4, 3, 7, BASE_LIGHT)
        generateBox(p, 3, 2, 7, 4, 2, 7, BASE_GRAY)
        generateBox(p, 3, 1, 6, 4, 1, 7, BASE_LIGHT)
      }
      if (def.hasOpening[WEST]) {
        generateBox(p, 0, 3, 3, 0, 3, 4, BASE_LIGHT)
      } else {
        generateBox(p, 0, 3, 3, 1, 3, 4, BASE_LIGHT)
        generateBox(p, 0, 2, 3, 0, 2, 4, BASE_GRAY)
        generateBox(p, 0, 1, 3, 1, 1, 4, BASE_LIGHT)
      }
      if (def.hasOpening[EAST]) {
        generateBox(p, 7, 3, 3, 7, 3, 4, BASE_LIGHT)
      } else {
        generateBox(p, 6, 3, 3, 7, 3, 4, BASE_LIGHT)
        generateBox(p, 7, 2, 3, 7, 2, 4, BASE_GRAY)
        generateBox(p, 6, 1, 3, 7, 1, 4, BASE_LIGHT)
      }
    } else if (p.mainDesign === 1) {
      generateBox(p, 2, 1, 2, 2, 3, 2, BASE_LIGHT)
      generateBox(p, 2, 1, 5, 2, 3, 5, BASE_LIGHT)
      generateBox(p, 5, 1, 5, 5, 3, 5, BASE_LIGHT)
      generateBox(p, 5, 1, 2, 5, 3, 2, BASE_LIGHT)
      placeBlock(p, LAMP, 2, 2, 2)
      placeBlock(p, LAMP, 2, 2, 5)
      placeBlock(p, LAMP, 5, 2, 5)
      placeBlock(p, LAMP, 5, 2, 2)
      generateBox(p, 0, 1, 0, 1, 3, 0, BASE_LIGHT)
      generateBox(p, 0, 1, 1, 0, 3, 1, BASE_LIGHT)
      generateBox(p, 0, 1, 7, 1, 3, 7, BASE_LIGHT)
      generateBox(p, 0, 1, 6, 0, 3, 6, BASE_LIGHT)
      generateBox(p, 6, 1, 7, 7, 3, 7, BASE_LIGHT)
      generateBox(p, 7, 1, 6, 7, 3, 6, BASE_LIGHT)
      generateBox(p, 6, 1, 0, 7, 3, 0, BASE_LIGHT)
      generateBox(p, 7, 1, 1, 7, 3, 1, BASE_LIGHT)
      placeBlock(p, BASE_GRAY, 1, 2, 0)
      placeBlock(p, BASE_GRAY, 0, 2, 1)
      placeBlock(p, BASE_GRAY, 1, 2, 7)
      placeBlock(p, BASE_GRAY, 0, 2, 6)
      placeBlock(p, BASE_GRAY, 6, 2, 7)
      placeBlock(p, BASE_GRAY, 7, 2, 6)
      placeBlock(p, BASE_GRAY, 6, 2, 0)
      placeBlock(p, BASE_GRAY, 7, 2, 1)
      if (!def.hasOpening[SOUTH]) {
        generateBox(p, 1, 3, 0, 6, 3, 0, BASE_LIGHT)
        generateBox(p, 1, 2, 0, 6, 2, 0, BASE_GRAY)
        generateBox(p, 1, 1, 0, 6, 1, 0, BASE_LIGHT)
      }
      if (!def.hasOpening[NORTH]) {
        generateBox(p, 1, 3, 7, 6, 3, 7, BASE_LIGHT)
        generateBox(p, 1, 2, 7, 6, 2, 7, BASE_GRAY)
        generateBox(p, 1, 1, 7, 6, 1, 7, BASE_LIGHT)
      }
      if (!def.hasOpening[WEST]) {
        generateBox(p, 0, 3, 1, 0, 3, 6, BASE_LIGHT)
        generateBox(p, 0, 2, 1, 0, 2, 6, BASE_GRAY)
        generateBox(p, 0, 1, 1, 0, 1, 6, BASE_LIGHT)
      }
      if (!def.hasOpening[EAST]) {
        generateBox(p, 7, 3, 1, 7, 3, 6, BASE_LIGHT)
        generateBox(p, 7, 2, 1, 7, 2, 6, BASE_GRAY)
        generateBox(p, 7, 1, 1, 7, 1, 6, BASE_LIGHT)
      }
    } else if (p.mainDesign === 2) {
      generateBox(p, 0, 1, 0, 0, 1, 7, BASE_LIGHT)
      generateBox(p, 7, 1, 0, 7, 1, 7, BASE_LIGHT)
      generateBox(p, 1, 1, 0, 6, 1, 0, BASE_LIGHT)
      generateBox(p, 1, 1, 7, 6, 1, 7, BASE_LIGHT)
      generateBox(p, 0, 2, 0, 0, 2, 7, BASE_BLACK)
      generateBox(p, 7, 2, 0, 7, 2, 7, BASE_BLACK)
      generateBox(p, 1, 2, 0, 6, 2, 0, BASE_BLACK)
      generateBox(p, 1, 2, 7, 6, 2, 7, BASE_BLACK)
      generateBox(p, 0, 3, 0, 0, 3, 7, BASE_LIGHT)
      generateBox(p, 7, 3, 0, 7, 3, 7, BASE_LIGHT)
      generateBox(p, 1, 3, 0, 6, 3, 0, BASE_LIGHT)
      generateBox(p, 1, 3, 7, 6, 3, 7, BASE_LIGHT)
      generateBox(p, 0, 1, 3, 0, 2, 4, BASE_BLACK)
      generateBox(p, 7, 1, 3, 7, 2, 4, BASE_BLACK)
      generateBox(p, 3, 1, 0, 4, 2, 0, BASE_BLACK)
      generateBox(p, 3, 1, 7, 4, 2, 7, BASE_BLACK)
      if (def.hasOpening[SOUTH]) generateWaterBox(p, 3, 1, 0, 4, 2, 0)
      if (def.hasOpening[NORTH]) generateWaterBox(p, 3, 1, 7, 4, 2, 7)
      if (def.hasOpening[WEST]) generateWaterBox(p, 0, 1, 3, 0, 2, 4)
      if (def.hasOpening[EAST]) generateWaterBox(p, 7, 1, 3, 7, 2, 4)
    }
    if (centerPillar) {
      generateBox(p, 3, 1, 3, 4, 1, 4, BASE_LIGHT)
      generateBox(p, 3, 2, 3, 4, 2, 4, BASE_GRAY)
      generateBox(p, 3, 3, 3, 4, 3, 4, BASE_LIGHT)
    }
  }

  function simpleTopPost(p) {
    if (Math.floor(p.def.index / 25) > 0) generateDefaultFloor(p, 0, 0, p.def.hasOpening[DOWN])
    if (!p.def.connections[UP]) generateBoxOnFillOnly(p, 1, 4, 1, 6, 4, 6, BASE_GRAY)
    for (let x = 1; x <= 6; x++) for (let z = 1; z <= 6; z++) {
      if (ni(3) !== 0) {
        const y0 = 2 + (ni(4) === 0 ? 0 : 1)
        generateBox(p, x, y0, z, x, 3, z, SPONGE)
      }
    }
    generateBox(p, 0, 1, 0, 0, 1, 7, BASE_LIGHT)
    generateBox(p, 7, 1, 0, 7, 1, 7, BASE_LIGHT)
    generateBox(p, 1, 1, 0, 6, 1, 0, BASE_LIGHT)
    generateBox(p, 1, 1, 7, 6, 1, 7, BASE_LIGHT)
    generateBox(p, 0, 2, 0, 0, 2, 7, BASE_BLACK)
    generateBox(p, 7, 2, 0, 7, 2, 7, BASE_BLACK)
    generateBox(p, 1, 2, 0, 6, 2, 0, BASE_BLACK)
    generateBox(p, 1, 2, 7, 6, 2, 7, BASE_BLACK)
    generateBox(p, 0, 3, 0, 0, 3, 7, BASE_LIGHT)
    generateBox(p, 7, 3, 0, 7, 3, 7, BASE_LIGHT)
    generateBox(p, 1, 3, 0, 6, 3, 0, BASE_LIGHT)
    generateBox(p, 1, 3, 7, 6, 3, 7, BASE_LIGHT)
    generateBox(p, 0, 1, 3, 0, 2, 4, BASE_BLACK)
    generateBox(p, 7, 1, 3, 7, 2, 4, BASE_BLACK)
    generateBox(p, 3, 1, 0, 4, 2, 0, BASE_BLACK)
    generateBox(p, 3, 1, 7, 4, 2, 7, BASE_BLACK)
    if (p.def.hasOpening[SOUTH]) generateWaterBox(p, 3, 1, 0, 4, 2, 0)
  }

  function wingPost(p) {
    if (p.mainDesign === 0) {
      for (let i = 0; i < 4; i++) generateBox(p, 10 - i, 3 - i, 20 - i, 12 + i, 3 - i, 20, BASE_LIGHT)
      generateBox(p, 7, 0, 6, 15, 0, 16, BASE_LIGHT)
      generateBox(p, 6, 0, 6, 6, 3, 20, BASE_LIGHT)
      generateBox(p, 16, 0, 6, 16, 3, 20, BASE_LIGHT)
      generateBox(p, 7, 1, 7, 7, 1, 20, BASE_LIGHT)
      generateBox(p, 15, 1, 7, 15, 1, 20, BASE_LIGHT)
      generateBox(p, 7, 1, 6, 9, 3, 6, BASE_LIGHT)
      generateBox(p, 13, 1, 6, 15, 3, 6, BASE_LIGHT)
      generateBox(p, 8, 1, 7, 9, 1, 7, BASE_LIGHT)
      generateBox(p, 13, 1, 7, 14, 1, 7, BASE_LIGHT)
      generateBox(p, 9, 0, 5, 13, 0, 5, BASE_LIGHT)
      generateBox(p, 10, 0, 7, 12, 0, 7, BASE_BLACK)
      generateBox(p, 8, 0, 10, 8, 0, 12, BASE_BLACK)
      generateBox(p, 14, 0, 10, 14, 0, 12, BASE_BLACK)
      for (let z = 18; z >= 7; z -= 3) {
        placeBlock(p, LAMP, 6, 3, z)
        placeBlock(p, LAMP, 16, 3, z)
      }
      placeBlock(p, LAMP, 10, 0, 10)
      placeBlock(p, LAMP, 12, 0, 10)
      placeBlock(p, LAMP, 10, 0, 12)
      placeBlock(p, LAMP, 12, 0, 12)
      placeBlock(p, LAMP, 8, 3, 6)
      placeBlock(p, LAMP, 14, 3, 6)
      placeBlock(p, BASE_LIGHT, 4, 2, 4)
      placeBlock(p, LAMP, 4, 1, 4)
      placeBlock(p, BASE_LIGHT, 4, 0, 4)
      placeBlock(p, BASE_LIGHT, 18, 2, 4)
      placeBlock(p, LAMP, 18, 1, 4)
      placeBlock(p, BASE_LIGHT, 18, 0, 4)
      placeBlock(p, BASE_LIGHT, 4, 2, 18)
      placeBlock(p, LAMP, 4, 1, 18)
      placeBlock(p, BASE_LIGHT, 4, 0, 18)
      placeBlock(p, BASE_LIGHT, 18, 2, 18)
      placeBlock(p, LAMP, 18, 1, 18)
      placeBlock(p, BASE_LIGHT, 18, 0, 18)
      placeBlock(p, BASE_LIGHT, 9, 7, 20)
      placeBlock(p, BASE_LIGHT, 13, 7, 20)
      generateBox(p, 6, 0, 21, 7, 4, 21, BASE_LIGHT)
      generateBox(p, 15, 0, 21, 16, 4, 21, BASE_LIGHT)
    } else if (p.mainDesign === 1) {
      generateBox(p, 9, 3, 18, 13, 3, 20, BASE_LIGHT)
      generateBox(p, 9, 0, 18, 9, 2, 18, BASE_LIGHT)
      generateBox(p, 13, 0, 18, 13, 2, 18, BASE_LIGHT)
      let x = 9
      for (let i = 0; i < 2; i++) {
        placeBlock(p, BASE_LIGHT, x, 6, 20)
        placeBlock(p, LAMP, x, 5, 20)
        placeBlock(p, BASE_LIGHT, x, 4, 20)
        x = 13
      }
      generateBox(p, 7, 3, 7, 15, 3, 14, BASE_LIGHT)
      x = 10
      for (let i = 0; i < 2; i++) {
        generateBox(p, x, 0, 10, x, 6, 10, BASE_LIGHT)
        generateBox(p, x, 0, 12, x, 6, 12, BASE_LIGHT)
        placeBlock(p, LAMP, x, 0, 10)
        placeBlock(p, LAMP, x, 0, 12)
        placeBlock(p, LAMP, x, 4, 10)
        placeBlock(p, LAMP, x, 4, 12)
        x = 12
      }
      x = 8
      for (let i = 0; i < 2; i++) {
        generateBox(p, x, 0, 7, x, 2, 7, BASE_LIGHT)
        generateBox(p, x, 0, 14, x, 2, 14, BASE_LIGHT)
        x = 14
      }
      generateBox(p, 8, 3, 8, 8, 3, 13, BASE_BLACK)
      generateBox(p, 14, 3, 8, 14, 3, 13, BASE_BLACK)
    }
  }

  function penthousePost(p) {
    generateBox(p, 2, -1, 2, 11, -1, 11, BASE_LIGHT)
    generateBox(p, 0, -1, 0, 1, -1, 11, BASE_GRAY)
    generateBox(p, 12, -1, 0, 13, -1, 11, BASE_GRAY)
    generateBox(p, 2, -1, 0, 11, -1, 1, BASE_GRAY)
    generateBox(p, 2, -1, 12, 11, -1, 13, BASE_GRAY)
    generateBox(p, 0, 0, 0, 0, 0, 13, BASE_LIGHT)
    generateBox(p, 13, 0, 0, 13, 0, 13, BASE_LIGHT)
    generateBox(p, 1, 0, 0, 12, 0, 0, BASE_LIGHT)
    generateBox(p, 1, 0, 13, 12, 0, 13, BASE_LIGHT)
    for (let i = 2; i <= 11; i += 3) {
      placeBlock(p, LAMP, 0, 0, i)
      placeBlock(p, LAMP, 13, 0, i)
      placeBlock(p, LAMP, i, 0, 0)
    }
    generateBox(p, 2, 0, 3, 4, 0, 9, BASE_LIGHT)
    generateBox(p, 9, 0, 3, 11, 0, 9, BASE_LIGHT)
    generateBox(p, 4, 0, 9, 9, 0, 11, BASE_LIGHT)
    placeBlock(p, BASE_LIGHT, 5, 0, 8)
    placeBlock(p, BASE_LIGHT, 8, 0, 8)
    placeBlock(p, BASE_LIGHT, 10, 0, 10)
    placeBlock(p, BASE_LIGHT, 3, 0, 10)
    generateBox(p, 3, 0, 3, 3, 0, 7, BASE_BLACK)
    generateBox(p, 10, 0, 3, 10, 0, 7, BASE_BLACK)
    generateBox(p, 6, 0, 10, 7, 0, 10, BASE_BLACK)
    let x = 3
    for (let i = 0; i < 2; i++) {
      for (let z = 2; z <= 8; z += 3) generateBox(p, x, 0, z, x, 2, z, BASE_LIGHT)
      x = 10
    }
    generateBox(p, 5, 0, 10, 5, 2, 10, BASE_LIGHT)
    generateBox(p, 8, 0, 10, 8, 2, 10, BASE_LIGHT)
    generateBox(p, 6, -1, 7, 7, -1, 8, BASE_BLACK)
    generateWaterBox(p, 6, -1, 3, 7, -1, 4)
  }

  const childPost = {
    entry: entryPost, core: corePost,
    doubleX: doubleXPost, doubleXY: doubleXYPost, doubleY: doubleYPost,
    doubleYZ: doubleYZPost, doubleZ: doubleZPost,
    simple: simplePost, simpleTop: simpleTopPost,
    wing: wingPost, penthouse: penthousePost
  }

  // ---- postProcess, game order

  const b = building
  const waterHeight = Math.max(SEA_LEVEL, 64) - b.box.minY
  generateWaterBox(b, 0, 0, 0, 58, waterHeight, 58)
  generateWing(b, false, 0)
  generateWing(b, true, 33)
  generateEntranceArchs(b)
  generateEntranceWall(b)
  generateRoofPiece(b)
  generateLowerWall(b)
  generateMiddleWall(b)
  generateUpperWall(b)
  for (let pillarX = 0; pillarX < 7; pillarX++) {
    let pillarZ = 0
    while (pillarZ < 7) {
      if (pillarZ === 0 && pillarX === 3) pillarZ = 6
      const bx = pillarX * 9
      const bz = pillarZ * 9
      // fillColumnDown grows these bases toward the sea floor in game; with
      // no terrain they become 4-block legs the monument stands on
      for (let w = 0; w < 4; w++) for (let d = 0; d < 4; d++) {
        for (let y = 0; y >= -4; y--) placeBlock(b, BASE_LIGHT, bx + w, y, bz + d)
      }
      if (pillarX !== 0 && pillarX !== 6) pillarZ += 6
      else pillarZ++
    }
  }
  for (let i = 0; i < 5; i++) {
    generateWaterBox(b, -1 - i, 0 + i * 2, -1 - i, -1 - i, 23, 58 + i)
    generateWaterBox(b, 58 + i, 0 + i * 2, -1 - i, 58 + i, 23, 58 + i)
    generateWaterBox(b, 0 - i, 0 + i * 2, -1 - i, 57 + i, 23, -1 - i)
    generateWaterBox(b, 0 - i, 0 + i * 2, 58 + i, 57 + i, 23, 58 + i)
  }
  const entities = []
  const spawnElder = (p, x, y, z) => {
    const [wx, wy, wz] = getWorldPos(p, x, y, z)
    entities.push({ pos: [wx + 0.5, wy, wz + 0.5], nbt: { id: "minecraft:elder_guardian" } })
  }
  for (const child of childPieces) {
    childPost[child.kind](child)
    // the wing rooms and penthouse spawn their elder guardians directly
    if (child.kind === "wing") spawnElder(child, 11, child.mainDesign === 0 ? 2 : 5, child.mainDesign === 0 ? 16 : 13)
    if (child.kind === "penthouse") spawnElder(child, 6, 1, 6)
  }

  // ---- normalise to a structure. the water only exists so generation
  // carves like the game (doorways are water boxes); it stays out of the
  // output so the monument shows dry

  const dropped = c => palette[c.state].Name === AIR || palette[c.state].Name === WATER
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const c of cells.values()) {
    if (dropped(c)) continue
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], c.pos[i])
      hi[i] = Math.max(hi[i], c.pos[i])
    }
  }
  const blocks = []
  for (const c of cells.values()) {
    if (dropped(c)) continue
    blocks.push({ state: c.state, pos: [c.pos[0] - lo[0], c.pos[1] - lo[1], c.pos[2] - lo[2]] })
  }
  for (const e of entities) e.pos = [e.pos[0] - lo[0], e.pos[1] - lo[1], e.pos[2] - lo[2]]
  return {
    structure: {
      size: [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1],
      palette, blocks, entities,
      anchor: [-lo[0], -lo[1], -lo[2]]
    },
    maxDepth: 1
  }
}
