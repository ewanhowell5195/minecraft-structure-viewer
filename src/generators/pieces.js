import { mirrorState, rotateState } from "../transforms.js"

// StructurePiece orientation model: pieces are stored in north-placement space
// (geometry z-flipped by getWorldZ); placing converts to the other directions.

// BoundingBox.orientBox: width/depth swap on the x axis directions
export function orientBox(footX, footY, footZ, offX, offY, offZ, w, h, d, dir) {
  switch (dir) {
    case "north": return { minX: footX + offX, minY: footY + offY, minZ: footZ - d + 1 + offZ, maxX: footX + w - 1 + offX, maxY: footY + h - 1 + offY, maxZ: footZ + offZ }
    case "west": return { minX: footX - d + 1 + offZ, minY: footY + offY, minZ: footZ + offX, maxX: footX + offZ, maxY: footY + h - 1 + offY, maxZ: footZ + w - 1 + offX }
    case "east": return { minX: footX + offZ, minY: footY + offY, minZ: footZ + offX, maxX: footX + d - 1 + offZ, maxY: footY + h - 1 + offY, maxZ: footZ + w - 1 + offX }
    default: return { minX: footX + offX, minY: footY + offY, minZ: footZ + offZ, maxX: footX + w - 1 + offX, maxY: footY + h - 1 + offY, maxZ: footZ + d - 1 + offZ }
  }
}

export const boxesIntersect = (a, b) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY && a.minZ <= b.maxZ && a.maxZ >= b.minZ

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
    : ([x, y, z]) => [d - 1 - z, y, x]
  return {
    ...struct,
    size: rot ? [d, h, w] : struct.size,
    palette,
    blocks: struct.blocks.map(b => ({ ...b, pos: pos(b.pos) }))
  }
}

// `ow: true` matches postProcess overwrite order
export function placePiece(struct, dir, box) {
  return { struct: orientStruct(struct, dir), rot: 0, off: [box.minX, box.minY, box.minZ], ow: true }
}
