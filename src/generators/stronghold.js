import { HORIZ, rnd } from "../transforms.js"
import { combine } from "../combine.js"
import { boxesIntersect, orientBox, placePiece } from "./pieces.js"
import { readMasks } from "./builtin.js"

// stronghold (StrongholdPieces): the nbts are one canonical roll (plain stone,
// OPENING doorways, no side exits); per-instance randomness is stamped on top.

const P = {
  straight: { off: [-1, -1, 0], size: [5, 5, 7], door: [1, 1, 0] },
  prison_hall: { off: [-1, -1, 0], size: [9, 5, 11], door: [1, 1, 0] },
  left_turn: { off: [-1, -1, 0], size: [5, 5, 5], door: [1, 1, 0] },
  right_turn: { off: [-1, -1, 0], size: [5, 5, 5], door: [1, 1, 0] },
  room_crossing: { off: [-4, -1, 0], size: [11, 7, 11], door: [4, 1, 0] },
  straight_stairs_down: { off: [-1, -7, 0], size: [5, 11, 8], door: [1, 7, 0] },
  stairs_down: { off: [-1, -7, 0], size: [5, 11, 5], door: [1, 7, 0] },
  five_crossing: { off: [-4, -3, 0], size: [10, 9, 11], door: [4, 3, 0] },
  chest_corridor: { off: [-1, -1, 0], size: [5, 5, 7], door: [1, 1, 0] },
  library: { off: [-4, -1, 0], size: [14, 11, 15], door: [4, 1, 0] },
  portal_room: { off: [-4, -1, 0], size: [11, 8, 16] },
  filler_corridor: {}
}

// weight, maxPlaceCount, extra doPlace depth condition
const WEIGHTS = [
  ["straight", 40, 0], ["prison_hall", 5, 5], ["left_turn", 20, 0], ["right_turn", 20, 0],
  ["room_crossing", 10, 6], ["straight_stairs_down", 5, 5], ["stairs_down", 5, 5],
  ["five_crossing", 5, 4], ["chest_corridor", 5, 4],
  ["library", 10, 2, d => d > 4], ["portal_room", 20, 1, d => d > 5]
]

const NBTS = [
  "straight", "prison_hall", "left_turn", "right_turn",
  "room_crossing_0", "room_crossing_1", "room_crossing_2", "room_crossing_3",
  "straight_stairs_down", "stairs_down", "five_crossing", "chest_corridor",
  "library", "library_short", "portal_room"
]

function makeBox(x, y, z, dir, w, h, d) {
  return dir === "east" || dir === "west"
    ? { minX: x, minY: y, minZ: z, maxX: x + d - 1, maxY: y + h - 1, maxZ: z + w - 1 }
    : { minX: x, minY: y, minZ: z, maxX: x + w - 1, maxY: y + h - 1, maxZ: z + d - 1 }
}

const STONES = "minecraft:stone_bricks"
const rollStone = r => r < 0.2 ? "minecraft:cracked_stone_bricks" : r < 0.5 ? "minecraft:mossy_stone_bricks" : r < 0.55 ? "minecraft:infested_stone_bricks" : STONES

// authored spec coords vs north-placement nbt space: z flips between them
const flipCells = (cells, depth) => cells.map(([p, ...rest]) => [[p[0], p[1], depth - 1 - p[2]], ...rest])

// a stamp shares the parent's size so it rides the same orientation transform
function stamp(size, cells) {
  const palette = [], palIdx = new Map(), blocks = []
  for (const [pos, Name, Properties, nbt] of cells) {
    const pk = Name + "|" + JSON.stringify(Properties ?? null)
    let i = palIdx.get(pk)
    if (i === undefined) {
      i = palette.length
      palette.push(Properties ? { Name, Properties } : { Name })
      palIdx.set(pk, i)
    }
    const b = { state: i, pos }
    if (nbt) b.nbt = nbt
    blocks.push(b)
  }
  return { size, palette, blocks }
}

const boxCells = (x0, y0, z0, x1, y1, z1, Name, Properties) => {
  const out = []
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push([[x, y, z], Name, Properties])
  return out
}

// StrongholdPiece.generateSmallDoor stamped over the canonical OPENING
function doorCells(type, [fx, fy, fz]) {
  if (type === "wood_door" || type === "iron_door") {
    const door = type === "wood_door" ? "minecraft:oak_door" : "minecraft:iron_door"
    const cells = [
      [[fx, fy, fz], STONES], [[fx, fy + 1, fz], STONES], [[fx, fy + 2, fz], STONES],
      [[fx + 1, fy + 2, fz], STONES], [[fx + 2, fy + 2, fz], STONES], [[fx + 2, fy + 1, fz], STONES], [[fx + 2, fy, fz], STONES],
      [[fx + 1, fy, fz], door], [[fx + 1, fy + 1, fz], door, { half: "upper" }]
    ]
    if (type === "iron_door") {
      cells.push([[fx + 2, fy + 1, fz + 1], "minecraft:stone_button", { facing: "north", face: "wall" }])
      cells.push([[fx + 2, fy + 1, fz - 1], "minecraft:stone_button", { facing: "south", face: "wall" }])
    }
    return cells
  }
  if (type === "grates") {
    return [
      [[fx + 1, fy, fz], "minecraft:cave_air"], [[fx + 1, fy + 1, fz], "minecraft:cave_air"],
      [[fx, fy, fz], "minecraft:iron_bars", { west: "true" }], [[fx, fy + 1, fz], "minecraft:iron_bars", { west: "true" }],
      [[fx, fy + 2, fz], "minecraft:iron_bars", { east: "true", west: "true" }],
      [[fx + 1, fy + 2, fz], "minecraft:iron_bars", { east: "true", west: "true" }],
      [[fx + 2, fy + 2, fz], "minecraft:iron_bars", { east: "true", west: "true" }],
      [[fx + 2, fy + 1, fz], "minecraft:iron_bars", { east: "true" }], [[fx + 2, fy, fz], "minecraft:iron_bars", { east: "true" }]
    ]
  }
  return null
}

export async function runStronghold(loadStruct, { maxDepth = Infinity, seed } = {}) {
  const baseSeed = seed ?? (Math.random() * 0x100000000) >>> 0

  const tpl = {}, masks = {}
  for (const name of NBTS) {
    tpl[name] = await loadStruct("builtin/stronghold/" + name)
    if (!tpl[name]) return { structure: combine([]), maxDepth: 0 }
    masks[name] = (await readMasks("stronghold/" + name))?.stone ?? []
  }

  // whole-layout retry until a portal room places (StrongholdStructure)
  let pieces = null, rand = null
  for (let tries = 0; tries < 200; tries++) {
    rand = rnd((baseSeed + tries) >>> 0)
    const attempt = solve(rand)
    if (attempt.portal && attempt.pieces.length) { pieces = attempt.pieces; break }
  }
  if (!pieces) return { structure: combine([]), maxDepth: 0 }

  function solve(rand) {
    const ni = n => Math.floor(rand() * n)
    const nb = () => rand() < 0.5
    const weights = WEIGHTS.map(([name, weight, max, cond]) => ({ name, weight, max, cond, placed: 0 }))
    let list = weights.slice()
    let imposed = null, previousPiece = null, portal = false
    const pieces = [], pending = []

    const randomSmallDoor = () => ["opening", "opening", "wood_door", "grates", "iron_door"][ni(5)]

    function create(name, fx, fy, fz, dir, depth) {
      if (name === "library") {
        let box = orientBox(fx, fy, fz, -4, -1, 0, 14, 11, 15, dir), tall = true
        if (box.minY <= 10 || pieces.some(o => boxesIntersect(o.box, box))) {
          box = orientBox(fx, fy, fz, -4, -1, 0, 14, 6, 15, dir)
          tall = false
          if (box.minY <= 10 || pieces.some(o => boxesIntersect(o.box, box))) return null
        }
        return { name, box, dir, genDepth: depth, tall, door: randomSmallDoor() }
      }
      const p = P[name]
      const box = orientBox(fx, fy, fz, p.off[0], p.off[1], p.off[2], p.size[0], p.size[1], p.size[2], dir)
      if (box.minY <= 10 || pieces.some(o => boxesIntersect(o.box, box))) return null
      const piece = { name, box, dir, genDepth: depth }
      if (name !== "portal_room") piece.door = randomSmallDoor()
      if (name === "straight") { piece.leftChild = ni(2) === 0; piece.rightChild = ni(2) === 0 }
      if (name === "room_crossing") piece.type = ni(5)
      if (name === "five_crossing") {
        piece.leftLow = nb(); piece.leftHigh = nb(); piece.rightLow = nb(); piece.rightHigh = ni(3) > 0
      }
      return piece
    }

    function fillerBox(fx, fy, fz, dir) {
      const probe = orientBox(fx, fy, fz, -1, -1, 0, 5, 5, 4, dir)
      const hit = pieces.find(o => boxesIntersect(o.box, probe))
      if (!hit) return null
      if (hit.box.minY !== probe.minY) return null
      for (let d = 2; d >= 1; d--) {
        const b = orientBox(fx, fy, fz, -1, -1, 0, 5, 5, d, dir)
        if (!boxesIntersect(hit.box, b)) return orientBox(fx, fy, fz, -1, -1, 0, 5, 5, d + 1, dir)
      }
      return null
    }

    function generatePieceFromSmallDoor(fx, fy, fz, dir, depth) {
      const any = list.some(w => w.max > 0 && w.placed < w.max)
      if (!any) return null
      const total = list.reduce((a, w) => a + w.weight, 0)
      if (imposed) {
        const name = imposed
        imposed = null
        const p = create(name, fx, fy, fz, dir, depth)
        if (p) return register(p)
      }
      for (let attempts = 0; attempts < 5; attempts++) {
        let sel = ni(total)
        for (const w of list) {
          sel -= w.weight
          if (sel < 0) {
            const doPlace = (w.max === 0 || w.placed < w.max) && (!w.cond || w.cond(depth))
            if (!doPlace || w === previousPiece) break
            const p = create(w.name, fx, fy, fz, dir, depth)
            if (p) {
              w.placed++
              previousPiece = w
              if (w.max !== 0 && w.placed >= w.max) list = list.filter(x => x !== w)
              return register(p)
            }
          }
        }
      }
      const box = fillerBox(fx, fy, fz, dir)
      return box && box.minY > 1 ? register({ name: "filler_corridor", box, dir, genDepth: depth }) : null
    }

    function register(p) {
      if (p.name === "portal_room") portal = true
      return p
    }

    function generateAndAddPiece(parent, fx, fy, fz, dir) {
      if (parent.genDepth > 50) return
      if (Math.abs(fx - start.box.minX) > 112 || Math.abs(fz - start.box.minZ) > 112) return
      const piece = generatePieceFromSmallDoor(fx, fy, fz, dir, parent.genDepth + 1)
      if (piece) {
        pieces.push(piece)
        pending.push(piece)
      }
    }

    const forward = (p, xOff, yOff) => {
      const b = p.box
      if (p.dir === "north") generateAndAddPiece(p, b.minX + xOff, b.minY + yOff, b.minZ - 1, "north")
      else if (p.dir === "south") generateAndAddPiece(p, b.minX + xOff, b.minY + yOff, b.maxZ + 1, "south")
      else if (p.dir === "west") generateAndAddPiece(p, b.minX - 1, b.minY + yOff, b.minZ + xOff, "west")
      else if (p.dir === "east") generateAndAddPiece(p, b.maxX + 1, b.minY + yOff, b.minZ + xOff, "east")
    }
    const left = (p, yOff, zOff) => {
      const b = p.box
      if (p.dir === "north" || p.dir === "south") generateAndAddPiece(p, b.minX - 1, b.minY + yOff, b.minZ + zOff, "west")
      else generateAndAddPiece(p, b.minX + zOff, b.minY + yOff, b.minZ - 1, "north")
    }
    const right = (p, yOff, zOff) => {
      const b = p.box
      if (p.dir === "north" || p.dir === "south") generateAndAddPiece(p, b.maxX + 1, b.minY + yOff, b.minZ + zOff, "east")
      else generateAndAddPiece(p, b.minX + zOff, b.minY + yOff, b.maxZ + 1, "south")
    }

    const CHILDREN = {
      stairs_down(p) {
        if (p.isSource) imposed = "five_crossing"
        forward(p, 1, 1)
      },
      straight(p) {
        forward(p, 1, 1)
        if (p.leftChild) left(p, 1, 2)
        if (p.rightChild) right(p, 1, 2)
      },
      prison_hall(p) { forward(p, 1, 1) },
      left_turn(p) { p.dir !== "north" && p.dir !== "east" ? right(p, 1, 1) : left(p, 1, 1) },
      right_turn(p) { p.dir !== "north" && p.dir !== "east" ? left(p, 1, 1) : right(p, 1, 1) },
      room_crossing(p) { forward(p, 4, 1); left(p, 1, 4); right(p, 1, 4) },
      straight_stairs_down(p) { forward(p, 1, 1) },
      five_crossing(p) {
        let zOffA = 3, zOffB = 5
        if (p.dir === "west" || p.dir === "north") { zOffA = 5; zOffB = 3 }
        forward(p, 5, 1)
        if (p.leftLow) left(p, zOffA, 1)
        if (p.leftHigh) left(p, zOffB, 7)
        if (p.rightLow) right(p, zOffA, 1)
        if (p.rightHigh) right(p, zOffB, 7)
      },
      chest_corridor(p) { forward(p, 1, 1) }
    }

    const start = { name: "stairs_down", isSource: true, dir: HORIZ[ni(4)], genDepth: 0, door: "opening" }
    start.box = makeBox(2, 64, 2, start.dir, 5, 11, 5)
    pieces.push(start)
    CHILDREN.stairs_down(start)
    while (pending.length) {
      const piece = pending.splice(ni(pending.length), 1)[0]
      CHILDREN[piece.name]?.(piece)
    }
    return { pieces, portal }
  }

  // ---- assembly: piece, stone re-roll, detail stamps, then the door

  function fillerStruct(box, dir) {
    const steps = dir === "east" || dir === "west" ? box.maxX - box.minX + 1 : box.maxZ - box.minZ + 1
    const cells = []
    for (let i = 0; i < steps; i++) {
      for (let x = 0; x <= 4; x++) cells.push([[x, 0, i], STONES], [[x, 4, i], STONES])
      for (let y = 1; y <= 3; y++) {
        cells.push([[0, y, i], STONES], [[4, y, i], STONES])
        for (let x = 1; x <= 3; x++) cells.push([[x, y, i], "minecraft:cave_air"])
      }
    }
    return stamp([5, 5, steps], cells)
  }

  const naturalMax = Math.max(...pieces.map(p => p.genDepth))
  const kept = pieces.filter(p => p.genDepth <= maxDepth)
  const placed = []

  for (const p of kept) {
    if (p.name === "filler_corridor") {
      placed.push(placePiece(fillerStruct(p.box, p.dir), p.dir, p.box))
      continue
    }
    const nbtName = p.name === "room_crossing" ? "room_crossing_" + Math.min(p.type, 3)
      : p.name === "library" ? (p.tall ? "library" : "library_short")
      : p.name
    const size = p.name === "library" && !p.tall ? [14, 6, 15] : P[p.name].size
    placed.push(placePiece(tpl[nbtName], p.dir, p.box))

    // mask cells are in nbt space; the rest is authored coords, flipped on stamp
    const maskCells = []
    for (const [x, y, z] of masks[nbtName]) maskCells.push([[x, y, z], rollStone(rand())])
    const cells = []
    if (p.name === "straight") {
      for (const [pos, facing] of [[[1, 2, 1], "east"], [[3, 2, 1], "west"], [[1, 2, 5], "east"], [[3, 2, 5], "west"]]) {
        if (rand() < 0.1) cells.push([pos, "minecraft:wall_torch", { facing }])
      }
      if (p.leftChild) cells.push(...boxCells(0, 1, 2, 0, 3, 4, "minecraft:cave_air"))
      if (p.rightChild) cells.push(...boxCells(4, 1, 2, 4, 3, 4, "minecraft:cave_air"))
    }
    if ((p.name === "left_turn" || p.name === "right_turn") && (p.dir === "south" || p.dir === "west")) {
      // mirrored orientations exit the opposite wall: refill, carve the other side
      const canonicalX = p.name === "left_turn" ? 0 : 4
      for (let y = 1; y <= 3; y++) for (let z = 1; z <= 3; z++) cells.push([[canonicalX, y, z], rollStone(rand())])
      cells.push(...boxCells(4 - canonicalX, 1, 1, 4 - canonicalX, 3, 3, "minecraft:cave_air"))
    }
    if (p.name === "five_crossing") {
      if (p.leftLow) cells.push(...boxCells(0, 3, 1, 0, 5, 3, "minecraft:cave_air"))
      if (p.rightLow) cells.push(...boxCells(9, 3, 1, 9, 5, 3, "minecraft:cave_air"))
      if (p.leftHigh) cells.push(...boxCells(0, 5, 7, 0, 7, 9, "minecraft:cave_air"))
      if (p.rightHigh) cells.push(...boxCells(9, 5, 7, 9, 7, 9, "minecraft:cave_air"))
    }
    if (p.name === "library") {
      for (let y = 1; y <= 4; y++) for (let x = 2; x <= 11; x++) for (let z = 1; z <= 13; z++) {
        if (rand() <= 0.07) cells.push([[x, y, z], "minecraft:cobweb"])
      }
    }
    if (p.name === "portal_room") {
      const FRAMES = [
        [[4, 3, 8], "north"], [[5, 3, 8], "north"], [[6, 3, 8], "north"],
        [[4, 3, 12], "south"], [[5, 3, 12], "south"], [[6, 3, 12], "south"],
        [[3, 3, 9], "east"], [[3, 3, 10], "east"], [[3, 3, 11], "east"],
        [[7, 3, 9], "west"], [[7, 3, 10], "west"], [[7, 3, 11], "west"]
      ]
      let allEyes = true
      for (const [pos, facing] of FRAMES) {
        const eye = rand() > 0.9
        allEyes = allEyes && eye
        cells.push([pos, "minecraft:end_portal_frame", { facing, eye: String(eye) }])
      }
      if (allEyes) {
        for (let x = 4; x <= 6; x++) for (let z = 9; z <= 11; z++) cells.push([[x, 3, z], "minecraft:end_portal"])
      }
    }
    const stamped = maskCells.concat(flipCells(cells, size[2]))
    if (stamped.length) placed.push(placePiece(stamp(size, stamped), p.dir, p.box))

    if (p.door && p.door !== "opening") {
      const dc = doorCells(p.door, P[p.name].door)
      if (dc) placed.push(placePiece(stamp(size, flipCells(dc, size[2])), p.dir, p.box))
    }
  }

  // anchor on the start piece so the camera stays put across levels
  const structure = combine(placed)
  const sb = pieces[0].box
  structure.anchor = [structure.anchor[0] + sb.minX, structure.anchor[1] + sb.minY, structure.anchor[2] + sb.minZ]
  return { structure, maxDepth: naturalMax }
}
