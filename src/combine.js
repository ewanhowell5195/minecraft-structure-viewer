import { AIR, JIGSAW, REAL_AIR, STRUCT_VOID, mirrorPos, mirrorState, parseState, rotDir, rotPos, rotateState } from "./transforms.js"

// Flatten placed pieces into one structure. Pieces are { struct, rot, off,
// mir?, ow? } in placement order; later pieces win a cell. `ow` (overwrite)
// maps MC's per-piece BlockIgnoreProcessor: with it, template air CARVES
// (deletes) earlier blocks; without it air is skipped. Jigsaw pieces never
// carve; igloo and mansion always do; end city is per-piece.
const SB = /(^|:)structure_block$/
const CHEST_MARKER = /^Chest(West|East|South|North)$/

// entity positions are continuous, so the cell transforms shift by one on
// negated axes: cell [x, x+1) rotated 90 lands at [-x-1, -x), i.e. 1 - x
function rotPosF([x, y, z], k) {
  switch (k & 3) {
    case 1: return [1 - z, y, x]
    case 2: return [1 - x, y, 1 - z]
    case 3: return [z, y, 1 - x]
    default: return [x, y, z]
  }
}

function mirrorPosF([x, y, z], mir) {
  if (mir === "lr") return [x, y, 1 - z]
  if (mir === "fb") return [1 - x, y, z]
  return [x, y, z]
}

export function combine(pieces) {
  const entities = []
  for (const piece of pieces) {
    const { struct, rot = 0, off = [0, 0, 0], mir = null } = piece
    for (const e of struct.entities ?? []) {
      const p = rotPosF(mirrorPosF(e.pos, mir), rot)
      const nbt = structuredClone(e.nbt)
      if (Array.isArray(nbt?.Rotation)) {
        let yaw = Number(nbt.Rotation[0]) || 0
        if (mir === "lr") yaw = 180 - yaw
        if (mir === "fb") yaw = -yaw
        nbt.Rotation[0] = yaw + rot * 90
      }
      if (Array.isArray(nbt?.Motion)) nbt.Motion = rotPos(mirrorPos(nbt.Motion.map(Number), mir), rot)
      entities.push({ pos: [p[0] + off[0], p[1] + off[1], p[2] + off[2]], nbt })
    }
  }

  const cells = new Map()
  for (const piece of pieces) {
    const { struct, rot = 0, off = [0, 0, 0], mir = null, ow = false, keepJigsaws = false } = piece
    for (const b of struct.blocks) {
      const e = struct.palette[b.state]
      if (!e?.Name) continue
      if (STRUCT_VOID.test(e.Name)) continue
      const p = rotPos(mirrorPos(b.pos, mir), rot)
      const key = (p[0] + off[0]) + "," + (p[1] + off[1]) + "," + (p[2] + off[2])
      if (REAL_AIR.test(e.Name)) {
        if (ow) cells.delete(key)
        continue
      }
      if (SB.test(e.Name)) {
        // data markers are invisible and dropped, except the mansion's chest
        // markers (facing uses rotation only, as vanilla does)
        const m = typeof b.nbt?.metadata === "string" && b.nbt.metadata.match(CHEST_MARKER)
        if (m) cells.set(key, { Name: "minecraft:chest", Properties: { facing: rotDir(m[1].toLowerCase(), rot), type: "single" } })
        continue
      }
      if (JIGSAW.test(e.Name)) {
        // a piece whose jigsaws haven't run yet keeps them as jigsaw blocks
        // (vanilla only swaps in final_state once a jigsaw has been processed)
        if (!keepJigsaws) {
          const fs = parseState(typeof b.nbt?.final_state === "string" ? b.nbt.final_state : "")
          if (AIR.test(fs.Name)) continue
          cells.set(key, { Name: fs.Name, Properties: rotateState(mirrorState(fs.Properties, mir), rot) })
          continue
        }
      }
      cells.set(key, { Name: e.Name, Properties: rotateState(mirrorState(e.Properties, mir), rot), nbt: b.nbt })
    }
  }

  if (!cells.size) return { size: [1, 1, 1], palette: [{ Name: "minecraft:air" }], blocks: [{ state: 0, pos: [0, 0, 0] }], entities, anchor: [0, 0, 0] }

  // normalise to a non-negative grid; anchor = where the start piece's local
  // origin sits afterwards (the viewer keeps it visually fixed across levels)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  const parsed = []
  for (const [key, e] of cells) {
    const pos = key.split(",").map(Number)
    parsed.push([pos, e])
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], pos[i])
      hi[i] = Math.max(hi[i], pos[i])
    }
  }
  const palette = [], palIdx = new Map(), blocks = []
  for (const [pos, e] of parsed) {
    const pk = e.Name + "|" + JSON.stringify(e.Properties ?? null)
    let idx = palIdx.get(pk)
    if (idx === undefined) {
      idx = palette.length
      palette.push(e.Properties ? { Name: e.Name, Properties: e.Properties } : { Name: e.Name })
      palIdx.set(pk, idx)
    }
    const block = { state: idx, pos: [pos[0] - lo[0], pos[1] - lo[1], pos[2] - lo[2]] }
    if (e.nbt) block.nbt = e.nbt
    blocks.push(block)
  }
  for (const e of entities) {
    e.pos = [e.pos[0] - lo[0], e.pos[1] - lo[1], e.pos[2] - lo[2]]
  }
  return {
    size: [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1],
    palette, blocks, entities,
    anchor: [-lo[0], -lo[1], -lo[2]]
  }
}
