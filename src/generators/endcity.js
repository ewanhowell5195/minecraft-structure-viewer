import { add3, boxHit, pieceBox, rotPos, rnd } from "../transforms.js"
import { combine } from "../combine.js"

// end city (EndCityPieces): a recursive tower of base/floors/roofs, towers,
// bridges, an optional ship and fat towers. faithful port, including the
// subtree collision pruning (a branch is dropped if it hits an unrelated piece;
// a piece's `gen` tag lets it overlap the group it connects from). pieces
// connect by childOrigin = parentOrigin + rotate(offset, parentRotation).
export async function runEndCity(loadStruct, { maxDepth = Infinity, seed } = {}) {
  const rand = seed == null ? Math.random : rnd(seed)
  const NAMES = ["base_floor", "base_roof", "second_floor_1", "second_floor_2", "third_floor_1", "third_floor_2", "second_roof", "third_roof", "tower_base", "tower_piece", "tower_top", "bridge_end", "bridge_piece", "bridge_steep_stairs", "bridge_gentle_stairs", "ship", "fat_tower_base", "fat_tower_middle", "fat_tower_top"]
  const tpl = {}
  for (const n of NAMES) tpl[n] = await loadStruct("end_city/" + n)
  if (!tpl.base_floor) return { structure: combine([]), maxDepth: 0 }

  const nInt = n => Math.floor(rand() * n), nBool = () => rand() < 0.5
  const pieces = []
  let tag = 1, shipCreated = false
  const addH = (list, p) => { list.push(p); return p }
  // ow = MC's `overwrite` flag: true => STRUCTURE_BLOCK processor (air is placed,
  // carving doorways/ladders through earlier pieces); false => STRUCTURE_AND_AIR
  // (air skipped). only the interior floors/roofs are non-overwriting.
  // depth = graph distance from the root, one per outward piece, so a step grows
  // one piece at a time; `grp` keeps a piece on its parent's step (pieces that
  // always come together, a building's floors + roof, are one step)
  const addPiece = (parent, offset, name, rot, ow = true, grp = false) => {
    const origin = add3(parent.origin, rotPos(offset || [0, 0, 0], parent.rot))
    return { name, rot, origin, box: pieceBox(tpl[name], rot, origin), gen: 0, ow, depth: (parent.depth ?? 0) + (grp ? 0 : 1) }
  }
  const TOWER_BRIDGES = [[0, [1, -1, 0]], [1, [6, -1, 1]], [3, [0, -1, 5]], [2, [5, -1, 6]]]
  const FAT_BRIDGES = [[0, [4, -1, 0]], [1, [12, -1, 4]], [3, [0, -1, 8]], [2, [8, -1, 12]]]

  // generate a subtree into a fresh list; add it only if nothing collides
  const recursive = (gen, depth, parent, offset, list) => {
    if (depth > 8) return false
    const child = []
    if (!gen(depth, parent, offset, child)) return false
    const t = tag++
    for (const c of child) {
      if (c.gen !== -1) c.gen = t
      const hit = list.find(p => boxHit(p.box, c.box))
      if (hit && hit.gen !== parent.gen) return false
    }
    list.push(...child)
    return true
  }
  const houseTower = (depth, parent, offset, list) => {
    if (depth > 8) return false
    const r = parent.rot
    // the whole building (base_floor + any floors + its roof) is one step: a
    // bridge always lands on a complete building, floors always capped by a roof
    let last = addH(list, addPiece(parent, offset, "base_floor", r))
    const nf = nInt(3)
    if (nf === 0) addH(list, addPiece(last, [-1, 4, -1], "base_roof", r, true, true))
    else if (nf === 1) { last = addH(list, addPiece(last, [-1, 0, -1], "second_floor_2", r, false, true)); last = addH(list, addPiece(last, [-1, 8, -1], "second_roof", r, false, true)); recursive(tower, depth + 1, last, null, list) }
    else { last = addH(list, addPiece(last, [-1, 0, -1], "second_floor_2", r, false, true)); last = addH(list, addPiece(last, [-1, 4, -1], "third_floor_2", r, false, true)); last = addH(list, addPiece(last, [-1, 8, -1], "third_roof", r, true, true)); recursive(tower, depth + 1, last, null, list) }
    return true
  }
  const tower = (depth, parent, offset, list) => {
    const r = parent.rot
    // tower_base + its first tower_piece are both unconditional (always paired),
    // so they're one step: the tower's start, not a lone base stub
    let last = addH(list, addPiece(parent, [3 + nInt(2), -3, 3 + nInt(2)], "tower_base", r))
    last = addH(list, addPiece(last, [0, 7, 0], "tower_piece", r, true, true))
    let bridge = nInt(3) === 0 ? last : null
    const h = 1 + nInt(3)
    for (let i = 0; i < h; i++) { last = addH(list, addPiece(last, [0, 4, 0], "tower_piece", r)); if (i < h - 1 && nBool()) bridge = last }
    if (bridge) {
      for (const [br, bo] of TOWER_BRIDGES) if (nBool()) { const bs = addH(list, addPiece(bridge, bo, "bridge_end", (r + br) % 4)); recursive(towerBridge, depth + 1, bs, null, list) }
      addH(list, addPiece(last, [-1, 4, -1], "tower_top", r))
    } else if (depth !== 7) return recursive(fatTower, depth + 1, last, null, list)
    else addH(list, addPiece(last, [-1, 4, -1], "tower_top", r))
    return true
  }
  const towerBridge = (depth, parent, offset, list) => {
    const r = parent.rot
    const len = nInt(4) + 1
    let last = addH(list, addPiece(parent, [0, 0, -4], "bridge_piece", r))
    last.gen = -1
    let ny = 0
    for (let i = 0; i < len; i++) {
      if (nBool()) { last = addH(list, addPiece(last, [0, ny, -4], "bridge_piece", r)); ny = 0 }
      else { last = addH(list, nBool() ? addPiece(last, [0, ny, -4], "bridge_steep_stairs", r) : addPiece(last, [0, ny, -8], "bridge_gentle_stairs", r)); ny = 4 }
    }
    if (!shipCreated && nInt(10 - depth) === 0) { addH(list, addPiece(last, [-8 + nInt(8), ny, -70 + nInt(10)], "ship", r)); shipCreated = true }
    else if (!recursive(houseTower, depth + 1, last, [-3, ny + 1, -11], list)) return false
    addH(list, addPiece(last, [4, ny, 0], "bridge_end", (r + 2) % 4)).gen = -1
    return true
  }
  const fatTower = (depth, parent, offset, list) => {
    const r = parent.rot
    // same: fat_tower_base + its first middle are always paired => one step
    let last = addH(list, addPiece(parent, [-3, 4, -3], "fat_tower_base", r))
    last = addH(list, addPiece(last, [0, 4, 0], "fat_tower_middle", r, true, true))
    for (let i = 0; i < 2 && nInt(3) !== 0; i++) {
      last = addH(list, addPiece(last, [0, 8, 0], "fat_tower_middle", r))
      for (const [br, bo] of FAT_BRIDGES) if (nBool()) { const bs = addH(list, addPiece(last, bo, "bridge_end", (r + br) % 4)); recursive(towerBridge, depth + 1, bs, null, list) }
    }
    addH(list, addPiece(last, [-2, 8, -2], "fat_tower_top", r))
    return true
  }

  // startHouseTower: the root building (base + two floors + roof) is one step
  // (depth 0), then a tower grows up from it one piece at a time
  let last = addH(pieces, { name: "base_floor", rot: 0, origin: [0, 0, 0], box: pieceBox(tpl.base_floor, 0, [0, 0, 0]), gen: 0, depth: 0, ow: true })
  last = addH(pieces, addPiece(last, [-1, 0, -1], "second_floor_1", 0, false, true))
  last = addH(pieces, addPiece(last, [-1, 4, -1], "third_floor_1", 0, false, true))
  last = addH(pieces, addPiece(last, [-1, 8, -1], "third_roof", 0, true, true))
  recursive(tower, 1, last, null, pieces)

  const naturalMax = pieces.length ? Math.max(0, ...pieces.map(p => p.depth ?? 0)) : 0
  const kept = pieces.filter(p => (p.depth ?? 0) <= maxDepth)
  return { structure: combine(kept.map(p => ({ struct: tpl[p.name], rot: p.rot, off: p.origin, ow: p.ow }))), maxDepth: naturalMax }
}
