import { HORIZ, rnd } from "../transforms.js"
import { combine } from "../combine.js"
import { boxesIntersect, orientBox, placePiece } from "./pieces.js"

// nether fortress (NetherFortressPieces): a weighted piece graph grown by a
// random-order BFS over pendingChildren, faithful to the game including its
// quirks: a failed placement cascades down the weight list within the same
// attempt, and a piece past the 112 distance cutoff is created but never
// added. blocks come from the extracted piece nbts; only the jagged
// bridge end filler is shaped in code (its geometry is per-instance random).

// pillars: the authored x/z cells each piece fillColumnDowns below itself,
// grown into support legs down to the lava at assembly time
const rect = (x0, x1, z0, z1) => {
  const out = []
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push([x, z])
  return out
}
const bridgeEnds = rect(7, 11, 0, 2).concat(rect(7, 11, 16, 18), rect(0, 2, 7, 11), rect(16, 18, 7, 11))
const castleEnds = rect(4, 8, 0, 2).concat(rect(4, 8, 10, 12), rect(0, 2, 4, 8), rect(10, 12, 4, 8))

const P = {
  bridge_straight: { off: [-1, -3, 0], size: [5, 10, 19], pillars: rect(0, 4, 0, 2).concat(rect(0, 4, 16, 18)) },
  bridge_crossing: { off: [-8, -3, 0], size: [19, 10, 19], pillars: bridgeEnds },
  room_crossing: { off: [-2, 0, 0], size: [7, 9, 7], pillars: rect(0, 6, 0, 6) },
  stairs_room: { off: [-2, 0, 0], size: [7, 11, 7], pillars: rect(0, 6, 0, 6) },
  monster_throne: { off: [-2, 0, 0], size: [7, 8, 9], pillars: rect(0, 6, 0, 6) },
  castle_entrance: { off: [-5, -3, 0], size: [13, 14, 13], pillars: castleEnds },
  castle_small_corridor: { off: [-1, 0, 0], size: [5, 7, 5], pillars: rect(0, 4, 0, 4) },
  castle_small_corridor_right_turn: { off: [-1, 0, 0], size: [5, 7, 5], chest: [1, 2, 3], pillars: rect(0, 4, 0, 4) },
  castle_small_corridor_left_turn: { off: [-1, 0, 0], size: [5, 7, 5], chest: [3, 2, 3], pillars: rect(0, 4, 0, 4) },
  castle_corridor_stairs: { off: [-1, -7, 0], size: [5, 14, 10], pillars: rect(0, 4, 0, 9) },
  castle_corridor_t_balcony: { off: [-3, 0, 0], size: [9, 7, 9], pillars: rect(0, 8, 0, 5) },
  castle_small_corridor_crossing: { off: [-1, 0, 0], size: [5, 7, 5], pillars: rect(0, 4, 0, 4) },
  castle_stalk_room: { off: [-5, -3, 0], size: [13, 14, 13], pillars: castleEnds },
  bridge_end_filler: { off: [-1, -3, 0], size: [5, 10, 8] }
}

const BRIDGE_WEIGHTS = [
  ["bridge_straight", 30, 0, true],
  ["bridge_crossing", 10, 4],
  ["room_crossing", 10, 4],
  ["stairs_room", 10, 3],
  ["monster_throne", 5, 2],
  ["castle_entrance", 5, 1]
]
const CASTLE_WEIGHTS = [
  ["castle_small_corridor", 25, 0, true],
  ["castle_small_corridor_crossing", 15, 5],
  ["castle_small_corridor_right_turn", 5, 10],
  ["castle_small_corridor_left_turn", 5, 10],
  ["castle_corridor_stairs", 10, 3, true],
  ["castle_corridor_t_balcony", 7, 2],
  ["castle_stalk_room", 5, 2]
]

// StructurePiece.makeBoundingBox: width/depth swap on the x axis
function makeBox(x, y, z, dir, w, h, d) {
  return dir === "east" || dir === "west"
    ? { minX: x, minY: y, minZ: z, maxX: x + d - 1, maxY: y + h - 1, maxZ: z + w - 1 }
    : { minX: x, minY: y, minZ: z, maxX: x + w - 1, maxY: y + h - 1, maxZ: z + d - 1 }
}

// the jagged broken bridge end: rows of nether bricks with random lengths,
// in the exact roll order of BridgeEndFiller.postProcess. rows run from the
// attachment face, which sits at z 7 in north-placement nbt space
function endFillerStruct(selfSeed) {
  const r = rnd(selfSeed)
  const ni = n => Math.floor(r() * n)
  const blocks = []
  const row = (x, y, z1) => { for (let z = 0; z <= z1; z++) blocks.push({ state: 0, pos: [x, y, 7 - z] }) }
  for (let x = 0; x <= 4; x++) for (let y = 3; y <= 4; y++) row(x, y, ni(8))
  row(0, 5, ni(8))
  row(4, 5, ni(8))
  for (let x = 0; x <= 4; x++) row(x, 2, ni(5))
  for (let x = 0; x <= 4; x++) for (let y = 0; y <= 1; y++) row(x, y, ni(3))
  return { size: [5, 10, 8], palette: [{ Name: "minecraft:nether_bricks" }], blocks }
}

export async function runFortress(loadStruct, { maxDepth = Infinity, seed } = {}) {
  const rand = seed == null ? Math.random : rnd(seed)
  const ni = n => Math.floor(rand() * n)

  const tpl = {}
  for (const name of Object.keys(P)) {
    if (name === "bridge_end_filler") continue
    tpl[name] = await loadStruct("builtin/nether_fortress/" + name)
    if (!tpl[name]) return { structure: combine([]), maxDepth: 0 }
  }

  const pieces = []
  const pending = []
  const bridgeList = BRIDGE_WEIGHTS.map(([name, weight, max, allowInRow]) => ({ name, weight, max, allowInRow: !!allowInRow, placed: 0 }))
  const castleList = CASTLE_WEIGHTS.map(([name, weight, max, allowInRow]) => ({ name, weight, max, allowInRow: !!allowInRow, placed: 0 }))
  let previousPiece = null

  const start = { name: "bridge_crossing", dir: HORIZ[ni(4)], genDepth: 0 }
  start.box = makeBox(0, 64, 0, start.dir, 19, 10, 19)
  pieces.push(start)

  // NetherBridgePiece.createPiece: oriented box, y floor, collision check,
  // then the constructor's own rolls
  function create(name, fx, fy, fz, dir, depth) {
    const p = P[name]
    const box = orientBox(fx, fy, fz, p.off[0], p.off[1], p.off[2], p.size[0], p.size[1], p.size[2], dir)
    if (box.minY <= 10 || pieces.some(o => boxesIntersect(o.box, box))) return null
    const piece = { name, box, dir, genDepth: depth }
    if (name === "bridge_end_filler") piece.selfSeed = ni(0x100000000)
    if (p.chest) piece.hasChest = ni(3) === 0
    return piece
  }

  function generatePiece(list, fx, fy, fz, dir, depth) {
    let total = 0, any = false
    for (const w of list) {
      if (w.max > 0 && w.placed < w.max) any = true
      total += w.weight
    }
    if (!any) total = -1
    let attempts = 0
    while (attempts < 5 && total > 0 && depth <= 30) {
      attempts++
      let sel = ni(total)
      for (const w of list) {
        sel -= w.weight
        if (sel < 0) {
          if ((w.max !== 0 && w.placed >= w.max) || (w === previousPiece && !w.allowInRow)) break
          const piece = create(w.name, fx, fy, fz, dir, depth)
          if (piece) {
            w.placed++
            previousPiece = w
            if (w.max !== 0 && w.placed >= w.max) list.splice(list.indexOf(w), 1)
            return piece
          }
        }
      }
    }
    return create("bridge_end_filler", fx, fy, fz, dir, depth)
  }

  function generateAndAddPiece(parent, fx, fy, fz, dir, isCastle) {
    if (Math.abs(fx - start.box.minX) > 112 || Math.abs(fz - start.box.minZ) > 112) {
      // vanilla creates a cutoff end filler but never adds it
      create("bridge_end_filler", fx, fy, fz, dir, parent.genDepth)
      return
    }
    const piece = generatePiece(isCastle ? castleList : bridgeList, fx, fy, fz, dir, parent.genDepth + 1)
    if (piece) {
      pieces.push(piece)
      pending.push(piece)
    }
  }

  const forward = (p, xOff, yOff, castle) => {
    const b = p.box
    if (p.dir === "north") generateAndAddPiece(p, b.minX + xOff, b.minY + yOff, b.minZ - 1, "north", castle)
    else if (p.dir === "south") generateAndAddPiece(p, b.minX + xOff, b.minY + yOff, b.maxZ + 1, "south", castle)
    else if (p.dir === "west") generateAndAddPiece(p, b.minX - 1, b.minY + yOff, b.minZ + xOff, "west", castle)
    else if (p.dir === "east") generateAndAddPiece(p, b.maxX + 1, b.minY + yOff, b.minZ + xOff, "east", castle)
  }
  const left = (p, yOff, zOff, castle) => {
    const b = p.box
    if (p.dir === "north" || p.dir === "south") generateAndAddPiece(p, b.minX - 1, b.minY + yOff, b.minZ + zOff, "west", castle)
    else generateAndAddPiece(p, b.minX + zOff, b.minY + yOff, b.minZ - 1, "north", castle)
  }
  const right = (p, yOff, zOff, castle) => {
    const b = p.box
    if (p.dir === "north" || p.dir === "south") generateAndAddPiece(p, b.maxX + 1, b.minY + yOff, b.minZ + zOff, "east", castle)
    else generateAndAddPiece(p, b.minX + zOff, b.minY + yOff, b.maxZ + 1, "south", castle)
  }

  const CHILDREN = {
    bridge_crossing(p) { forward(p, 8, 3, false); left(p, 3, 8, false); right(p, 3, 8, false) },
    bridge_straight(p) { forward(p, 1, 3, false) },
    room_crossing(p) { forward(p, 2, 0, false); left(p, 0, 2, false); right(p, 0, 2, false) },
    stairs_room(p) { right(p, 6, 2, false) },
    castle_entrance(p) { forward(p, 5, 3, true) },
    castle_small_corridor(p) { forward(p, 1, 0, true) },
    castle_small_corridor_crossing(p) { forward(p, 1, 0, true); left(p, 0, 1, true); right(p, 0, 1, true) },
    castle_small_corridor_right_turn(p) { right(p, 0, 1, true) },
    castle_small_corridor_left_turn(p) { left(p, 0, 1, true) },
    castle_corridor_stairs(p) { forward(p, 1, 0, true) },
    castle_corridor_t_balcony(p) {
      const zOff = p.dir === "west" || p.dir === "north" ? 5 : 1
      left(p, 0, zOff, ni(8) > 0)
      right(p, 0, zOff, ni(8) > 0)
    },
    castle_stalk_room(p) { forward(p, 5, 3, true); forward(p, 5, 11, true) }
  }

  CHILDREN.bridge_crossing(start)
  while (pending.length) {
    const piece = pending.splice(ni(pending.length), 1)[0]
    CHILDREN[piece.name]?.(piece)
  }

  // the assembly keeps its in-game height band above the lava sea:
  // moveInsideHeights picks a y in [48, 70] and the lava surface sits at 31,
  // which becomes the viewer's grid plane once combine normalises
  const minY = Math.min(...pieces.map(p => p.box.minY))
  const span = Math.max(...pieces.map(p => p.box.maxY)) - minY + 1
  const range = 70 - 48 + 1 - span
  const base = range > 1 ? 48 + ni(range) : 48
  const lavaY = minY - (base - 31)

  const naturalMax = Math.max(...pieces.map(p => p.genDepth))
  const kept = pieces.filter(p => p.genDepth <= maxDepth)
  const placed = kept.map(p => {
    let struct = p.name === "bridge_end_filler" ? endFillerStruct(p.selfSeed) : tpl[p.name]
    const chest = P[p.name].chest
    if (chest && !p.hasChest) {
      // chest coords are authored; the nbt is in north-placement space
      const [cx, cy] = chest, cz = P[p.name].size[2] - 1 - chest[2]
      struct = { ...struct, blocks: struct.blocks.filter(b => b.pos[0] !== cx || b.pos[1] !== cy || b.pos[2] !== cz) }
    }
    return placePiece(struct, p.dir, p.box)
  })

  // fillColumnDown legs: each piece's pillar cells grow from under its box
  // down to the lava, stopping when they land on an earlier block
  const occupied = new Set()
  const AIRRE = /(^|:)(cave_)?air$/
  for (const entry of placed) {
    for (const b of entry.struct.blocks) {
      if (AIRRE.test(entry.struct.palette[b.state].Name)) continue
      occupied.add((b.pos[0] + entry.off[0]) + "," + (b.pos[1] + entry.off[1]) + "," + (b.pos[2] + entry.off[2]))
    }
  }
  const legs = []
  for (const p of kept) {
    const pillars = P[p.name].pillars
    if (!pillars) continue
    const d = P[p.name].size[2]
    for (const [ax, az] of pillars) {
      const zN = d - 1 - az
      const [bx, bz] = p.dir === "north" ? [ax, zN] : p.dir === "south" ? [ax, az] : p.dir === "west" ? [zN, ax] : [az, ax]
      const wx = p.box.minX + bx, wz = p.box.minZ + bz
      for (let y = p.box.minY - 1; y >= lavaY; y--) {
        const k = wx + "," + y + "," + wz
        if (occupied.has(k)) break
        occupied.add(k)
        legs.push({ state: 0, pos: [wx, y, wz] })
      }
    }
  }
  if (legs.length) placed.push({ struct: { size: [1, 1, 1], palette: [{ Name: "minecraft:nether_bricks" }], blocks: legs }, rot: 0, off: [0, 0, 0], ow: false })

  // anchor on the start piece's corner (the base nbt's origin), so the
  // camera stays glued to it across levels
  const structure = combine(placed)
  structure.anchor = [structure.anchor[0] + start.box.minX, structure.anchor[1] + start.box.minY, structure.anchor[2] + start.box.minZ]
  return { structure, maxDepth: naturalMax }
}
