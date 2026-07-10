import { mirrorState, rotateState } from "../transforms.js"

// Shared machinery for the extracted hardcoded pieces (nether fortress,
// stronghold): the game's StructurePiece orientation model. Pieces are
// extracted at orientation NORTH and stored exactly as they land in the
// world (states untransformed, geometry z-flipped by getWorldZ), so a raw
// nbt is self-consistent on its own. Placing one at a Direction converts
// from that north-placement space to the game's other placements:
//   north: identity
//   south: (x, y, D-1-z)      mirror left-right
//   west:  (z, y, x)          mirror left-right + rotate cw
//   east:  (D-1-z, y, x)      rotate cw
// The result is in box-local coords, pasted at the box min corner.

// BoundingBox.orientBox: the box a piece occupies for a given foot position,
// local offset and size. width/depth swap on the x axis directions.
export function orientBox(footX, footY, footZ, offX, offY, offZ, w, h, d, dir) {
  switch (dir) {
    case "north": return { minX: footX + offX, minY: footY + offY, minZ: footZ - d + 1 + offZ, maxX: footX + w - 1 + offX, maxY: footY + h - 1 + offY, maxZ: footZ + offZ }
    case "west": return { minX: footX - d + 1 + offZ, minY: footY + offY, minZ: footZ + offX, maxX: footX + offZ, maxY: footY + h - 1 + offY, maxZ: footZ + w - 1 + offX }
    case "east": return { minX: footX + offZ, minY: footY + offY, minZ: footZ + offX, maxX: footX + d - 1 + offZ, maxY: footY + h - 1 + offY, maxZ: footZ + w - 1 + offX }
    default: return { minX: footX + offX, minY: footY + offY, minZ: footZ + offZ, maxX: footX + w - 1 + offX, maxY: footY + h - 1 + offY, maxZ: footZ + d - 1 + offZ } // south
  }
}

export const boxesIntersect = (a, b) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY && a.minZ <= b.maxZ && a.maxZ >= b.minZ

// transform an extracted piece structure to box-local coords for a direction
export function orientStruct(struct, dir) {
  const [w, h, d] = struct.size
  if (dir === "north") return struct
  const mir = dir === "south" || dir === "west" ? "lr" : null
  const rot = dir === "west" || dir === "east" ? 1 : 0
  const palette = struct.palette.map(e => {
    let props = e.Properties
    if (props && mir) props = mirrorState(props, mir)
    if (props && rot) props = rotateState(props, rot)
    return props ? { Name: e.Name, Properties: props } : { Name: e.Name }
  })
  const pos = dir === "south" ? ([x, y, z]) => [x, y, d - 1 - z]
    : dir === "west" ? ([x, y, z]) => [z, y, x]
    : ([x, y, z]) => [d - 1 - z, y, x] // east
  return {
    ...struct,
    size: rot ? [d, h, w] : struct.size,
    palette,
    blocks: struct.blocks.map(b => ({ ...b, pos: pos(b.pos) }))
  }
}

// a placed code piece, ready for combine(): the oriented blocks at the box
// min corner. `ow: true` matches postProcess overwrite order.
export function placePiece(struct, dir, box) {
  return { struct: orientStruct(struct, dir), rot: 0, off: [box.minX, box.minY, box.minZ], ow: true }
}
