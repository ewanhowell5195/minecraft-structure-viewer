import { mirrorState, mix, rnd, rotateState } from "../transforms.js"

// mineshaft (MineshaftPieces): full code port. no terrain here, so a fake 2d
// cave stands in for open-cave air and pieces over it go suspended like in game.

const TYPES = {
  normal: { wood: "minecraft:oak_log", planks: "minecraft:oak_planks", fence: "minecraft:oak_fence" },
  mesa: { wood: "minecraft:dark_oak_log", planks: "minecraft:dark_oak_planks", fence: "minecraft:dark_oak_fence" }
}

// carver-style 2d tunnels on their own random stream, so the layout stays game-identical
function carveCave(seed, bLo, bHi, attempt) {
  const r = rnd(mix(mix(seed, 51966), attempt))
  const cells = new Set()
  const carve = (cx, cz, rad) => {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      for (let z = Math.floor(cz - rad); z <= Math.ceil(cz + rad); z++) {
        const dx = x + 0.5 - cx, dz = z + 0.5 - cz
        if (dx * dx + dz * dz <= rad * rad) cells.add(x + "," + z)
      }
    }
  }
  const tunnels = 1 + Math.floor(r() * 2)
  for (let t = 0; t < tunnels; t++) {
    const sx = bLo[0] + (0.25 + r() * 0.5) * (bHi[0] - bLo[0])
    const sz = bLo[1] + (0.25 + r() * 0.5) * (bHi[1] - bLo[1])
    const heading = r() * Math.PI * 2
    const base = 3 + r() * 3
    for (const dir of [0, Math.PI]) {
      let x = sx, z = sz, a = heading + dir
      const len = 40 + Math.floor(r() * 60)
      for (let i = 0; i < len; i++) {
        a += (r() - 0.5) * 0.5
        carve(x, z, Math.max(2, base + Math.sin(i / len * Math.PI) * 2 + (r() - 0.5)))
        x += Math.cos(a) * 2
        z += Math.sin(a) * 2
        if (x < bLo[0] - 8 || x > bHi[0] + 8 || z < bLo[1] - 8 || z > bHi[1] + 8) break
      }
    }
  }
  return cells
}

// single: null generates the whole shaft; otherwise one piece with its in-game rolls
export function makeMineshaft(typeName, single = null, fixedSections = null) {
  const T = TYPES[typeName]

  return async function runMineshaft(loadStruct, { maxDepth = Infinity, seed } = {}) {
    const baseSeed = seed ?? (Math.random() * 0x100000000) >>> 0
    const rand = rnd(baseSeed)
    const ni = n => Math.floor(rand() * n)

    // ---- layout (single stream, like the game's WorldgenRandom)

    const pieces = []

    function collides(box) {
      return pieces.some(p => p.box.minX <= box.maxX && p.box.maxX >= box.minX
        && p.box.minY <= box.maxY && p.box.maxY >= box.minY
        && p.box.minZ <= box.maxZ && p.box.maxZ >= box.minZ)
    }

    const makeRoom = () => ({
      kind: "room", dir: null, genDepth: 0, entrances: [],
      box: { minX: 0, minY: 50, minZ: 0, maxX: 7 + ni(6), maxY: 54 + ni(6), maxZ: 7 + ni(6) }
    })

    let room = null
    if (single === "room") {
      pieces.push(makeRoom())
    } else if (single) {
      const sections = fixedSections ?? ni(3) + 2
      const hasRails = single !== "spider_corridor" && ni(3) === 0
      pieces.push({
        kind: "corridor", dir: "south", genDepth: 0, sections, hasRails,
        spider: single === "spider_corridor",
        suspended: single === "suspended_corridor",
        box: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: sections * 5 - 1 }
      })
    } else {
      room = makeRoom()
      pieces.push(room)
    }

    function findCorridorSize(fx, fy, fz, dir) {
      for (let L = ni(3) + 2; L > 0; L--) {
        const bl = L * 5
        const box = dir === "north" ? { minX: 0, minY: 0, minZ: -(bl - 1), maxX: 2, maxY: 2, maxZ: 0 }
          : dir === "south" ? { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: bl - 1 }
          : dir === "west" ? { minX: -(bl - 1), minY: 0, minZ: 0, maxX: 0, maxY: 2, maxZ: 2 }
          : { minX: 0, minY: 0, minZ: 0, maxX: bl - 1, maxY: 2, maxZ: 2 }
        for (const k of ["minX", "maxX"]) box[k] += fx
        for (const k of ["minY", "maxY"]) box[k] += fy
        for (const k of ["minZ", "maxZ"]) box[k] += fz
        if (!collides(box)) return box
      }
      return null
    }

    function findCrossing(fx, fy, fz, dir) {
      const y1 = ni(4) === 0 ? 6 : 2
      const box = dir === "north" ? { minX: -1, minY: 0, minZ: -4, maxX: 3, maxY: y1, maxZ: 0 }
        : dir === "south" ? { minX: -1, minY: 0, minZ: 0, maxX: 3, maxY: y1, maxZ: 4 }
        : dir === "west" ? { minX: -4, minY: 0, minZ: -1, maxX: 0, maxY: y1, maxZ: 3 }
        : { minX: 0, minY: 0, minZ: -1, maxX: 4, maxY: y1, maxZ: 3 }
      for (const k of ["minX", "maxX"]) box[k] += fx
      for (const k of ["minY", "maxY"]) box[k] += fy
      for (const k of ["minZ", "maxZ"]) box[k] += fz
      return collides(box) ? null : box
    }

    function findStairs(fx, fy, fz, dir) {
      const box = dir === "north" ? { minX: 0, minY: -5, minZ: -8, maxX: 2, maxY: 2, maxZ: 0 }
        : dir === "south" ? { minX: 0, minY: -5, minZ: 0, maxX: 2, maxY: 2, maxZ: 8 }
        : dir === "west" ? { minX: -8, minY: -5, minZ: 0, maxX: 0, maxY: 2, maxZ: 2 }
        : { minX: 0, minY: -5, minZ: 0, maxX: 8, maxY: 2, maxZ: 2 }
      for (const k of ["minX", "maxX"]) box[k] += fx
      for (const k of ["minY", "maxY"]) box[k] += fy
      for (const k of ["minZ", "maxZ"]) box[k] += fz
      return collides(box) ? null : box
    }

    function createRandomShaftPiece(fx, fy, fz, dir, depth) {
      const sel = ni(100)
      if (sel >= 80) {
        const box = findCrossing(fx, fy, fz, dir)
        if (box) return { kind: "crossing", box, dir, genDepth: depth, twoFloored: box.maxY - box.minY + 1 > 3 }
      } else if (sel >= 70) {
        const box = findStairs(fx, fy, fz, dir)
        if (box) return { kind: "stairs", box, dir, genDepth: depth }
      } else {
        const box = findCorridorSize(fx, fy, fz, dir)
        if (box) {
          const hasRails = ni(3) === 0
          const spider = !hasRails && ni(23) === 0
          const axisZ = dir === "north" || dir === "south"
          const sections = (axisZ ? box.maxZ - box.minZ + 1 : box.maxX - box.minX + 1) / 5
          return { kind: "corridor", box, dir, genDepth: depth, hasRails, spider, sections }
        }
      }
      return null
    }

    function generateAndAddPiece(fx, fy, fz, dir, depth) {
      if (depth > 8) return null
      if (Math.abs(fx - room.box.minX) > 80 || Math.abs(fz - room.box.minZ) > 80) return null
      const piece = createRandomShaftPiece(fx, fy, fz, dir, depth + 1)
      if (piece) {
        pieces.push(piece)
        addChildren(piece)
      }
      return piece
    }

    function addChildren(p) {
      const b = p.box, depth = p.genDepth
      if (p.kind === "corridor") {
        const end = ni(4)
        const r3 = () => b.minY - 1 + ni(3)
        if (p.dir === "north") {
          if (end <= 1) generateAndAddPiece(b.minX, r3(), b.minZ - 1, "north", depth)
          else if (end === 2) generateAndAddPiece(b.minX - 1, r3(), b.minZ, "west", depth)
          else generateAndAddPiece(b.maxX + 1, r3(), b.minZ, "east", depth)
        } else if (p.dir === "south") {
          if (end <= 1) generateAndAddPiece(b.minX, r3(), b.maxZ + 1, "south", depth)
          else if (end === 2) generateAndAddPiece(b.minX - 1, r3(), b.maxZ - 3, "west", depth)
          else generateAndAddPiece(b.maxX + 1, r3(), b.maxZ - 3, "east", depth)
        } else if (p.dir === "west") {
          if (end <= 1) generateAndAddPiece(b.minX - 1, r3(), b.minZ, "west", depth)
          else if (end === 2) generateAndAddPiece(b.minX, r3(), b.minZ - 1, "north", depth)
          else generateAndAddPiece(b.minX, r3(), b.maxZ + 1, "south", depth)
        } else {
          if (end <= 1) generateAndAddPiece(b.maxX + 1, r3(), b.minZ, "east", depth)
          else if (end === 2) generateAndAddPiece(b.maxX - 3, r3(), b.minZ - 1, "north", depth)
          else generateAndAddPiece(b.maxX - 3, r3(), b.maxZ + 1, "south", depth)
        }
        if (depth < 8) {
          if (p.dir === "east" || p.dir === "west") {
            for (let x = b.minX + 3; x + 3 <= b.maxX; x += 5) {
              const sel = ni(5)
              if (sel === 0) generateAndAddPiece(x, b.minY, b.minZ - 1, "north", depth + 1)
              else if (sel === 1) generateAndAddPiece(x, b.minY, b.maxZ + 1, "south", depth + 1)
            }
          } else {
            for (let z = b.minZ + 3; z + 3 <= b.maxZ; z += 5) {
              const sel = ni(5)
              if (sel === 0) generateAndAddPiece(b.minX - 1, b.minY, z, "west", depth + 1)
              else if (sel === 1) generateAndAddPiece(b.maxX + 1, b.minY, z, "east", depth + 1)
            }
          }
        }
      } else if (p.kind === "crossing") {
        if (p.dir === "north") {
          generateAndAddPiece(b.minX + 1, b.minY, b.minZ - 1, "north", depth)
          generateAndAddPiece(b.minX - 1, b.minY, b.minZ + 1, "west", depth)
          generateAndAddPiece(b.maxX + 1, b.minY, b.minZ + 1, "east", depth)
        } else if (p.dir === "south") {
          generateAndAddPiece(b.minX + 1, b.minY, b.maxZ + 1, "south", depth)
          generateAndAddPiece(b.minX - 1, b.minY, b.minZ + 1, "west", depth)
          generateAndAddPiece(b.maxX + 1, b.minY, b.minZ + 1, "east", depth)
        } else if (p.dir === "west") {
          generateAndAddPiece(b.minX + 1, b.minY, b.minZ - 1, "north", depth)
          generateAndAddPiece(b.minX + 1, b.minY, b.maxZ + 1, "south", depth)
          generateAndAddPiece(b.minX - 1, b.minY, b.minZ + 1, "west", depth)
        } else {
          generateAndAddPiece(b.minX + 1, b.minY, b.minZ - 1, "north", depth)
          generateAndAddPiece(b.minX + 1, b.minY, b.maxZ + 1, "south", depth)
          generateAndAddPiece(b.maxX + 1, b.minY, b.minZ + 1, "east", depth)
        }
        if (p.twoFloored) {
          if (rand() < 0.5) generateAndAddPiece(b.minX + 1, b.minY + 4, b.minZ - 1, "north", depth)
          if (rand() < 0.5) generateAndAddPiece(b.minX - 1, b.minY + 4, b.minZ + 1, "west", depth)
          if (rand() < 0.5) generateAndAddPiece(b.maxX + 1, b.minY + 4, b.minZ + 1, "east", depth)
          if (rand() < 0.5) generateAndAddPiece(b.minX + 1, b.minY + 4, b.maxZ + 1, "south", depth)
        }
      } else if (p.kind === "stairs") {
        if (p.dir === "north") generateAndAddPiece(b.minX, b.minY, b.minZ - 1, "north", depth)
        else if (p.dir === "south") generateAndAddPiece(b.minX, b.minY, b.maxZ + 1, "south", depth)
        else if (p.dir === "west") generateAndAddPiece(b.minX - 1, b.minY, b.minZ, "west", depth)
        else generateAndAddPiece(b.maxX + 1, b.minY, b.minZ, "east", depth)
      } else if (p.kind === "room") {
        const heightSpace = Math.max(b.maxY - b.minY + 1 - 3 - 1, 1)
        const xSpan = b.maxX - b.minX + 1, zSpan = b.maxZ - b.minZ + 1
        const walls = [
          [xSpan, pos => [b.minX + pos, b.minY + ni(heightSpace) + 1, b.minZ - 1, "north"], cb => ({ minX: cb.minX, minY: cb.minY, minZ: b.minZ, maxX: cb.maxX, maxY: cb.maxY, maxZ: b.minZ + 1 })],
          [xSpan, pos => [b.minX + pos, b.minY + ni(heightSpace) + 1, b.maxZ + 1, "south"], cb => ({ minX: cb.minX, minY: cb.minY, minZ: b.maxZ - 1, maxX: cb.maxX, maxY: cb.maxY, maxZ: b.maxZ })],
          [zSpan, pos => [b.minX - 1, b.minY + ni(heightSpace) + 1, b.minZ + pos, "west"], cb => ({ minX: b.minX, minY: cb.minY, minZ: cb.minZ, maxX: b.minX + 1, maxY: cb.maxY, maxZ: cb.maxZ })],
          [zSpan, pos => [b.maxX + 1, b.minY + ni(heightSpace) + 1, b.minZ + pos, "east"], cb => ({ minX: b.maxX - 1, minY: cb.minY, minZ: cb.minZ, maxX: b.maxX, maxY: cb.maxY, maxZ: cb.maxZ })]
        ]
        for (const [span, at, entrance] of walls) {
          let pos = 0
          while (pos < span) {
            pos += ni(span)
            if (pos + 3 > span) break
            const child = generateAndAddPiece(...at(pos), depth)
            if (child) p.entrances.push(entrance(child.box))
            pos += 4
          }
        }
      }
    }

    if (room) addChildren(room)

    // virtual cave ceiling for suspended chains to hang from
    const ceilY = Math.max(...pieces.map(p => p.box.maxY)) + 8

    // the start room always spawns in rock: re-roll the cave until it misses it
    let cave = null
    if (!single) {
      const bLo = [Infinity, Infinity], bHi = [-Infinity, -Infinity]
      for (const p of pieces) {
        bLo[0] = Math.min(bLo[0], p.box.minX); bHi[0] = Math.max(bHi[0], p.box.maxX)
        bLo[1] = Math.min(bLo[1], p.box.minZ); bHi[1] = Math.max(bHi[1], p.box.maxZ)
      }
      const rb = room.box
      for (let attempt = 0; attempt < 40; attempt++) {
        cave = carveCave(baseSeed, bLo, bHi, attempt)
        let clear = true
        for (let x = rb.minX - 2; x <= rb.maxX + 2 && clear; x++) {
          for (let z = rb.minZ - 2; z <= rb.maxZ + 2 && clear; z++) {
            if (cave.has(x + "," + z)) clear = false
          }
        }
        if (clear) break
      }
      for (let x = rb.minX - 2; x <= rb.maxX + 2; x++) {
        for (let z = rb.minZ - 2; z <= rb.maxZ + 2; z++) cave.delete(x + "," + z)
      }
    }

    // ---- block emission into one world-space cell map, piece order

    const naturalMax = Math.max(...pieces.map(p => p.genDepth))
    const kept = pieces.map((p, i) => [p, i]).filter(([p]) => p.genDepth <= maxDepth)

    const palette = [], palIdx = new Map()
    const stateFor = (Name, Properties) => {
      const pk = Name + "|" + JSON.stringify(Properties ?? null)
      let i = palIdx.get(pk)
      if (i === undefined) {
        i = palette.length
        palette.push(Properties ? { Name, Properties } : { Name })
        palIdx.set(pk, i)
      }
      return i
    }
    const cells = new Map()
    const entities = []
    const key = (x, y, z) => x + "," + y + "," + z
    const KEEP = new RegExp(`^(${T.planks}|${T.wood}|${T.fence}|minecraft:iron_chain)$`)
    const AIRRE = /(^|:)(cave_)?air$/

    // the mineshaft never overwrites its own planks/wood/fences/chains
    function place(wx, wy, wz, Name, Properties, nbt) {
      const k = key(wx, wy, wz)
      const existing = cells.get(k)
      if (existing && KEEP.test(palette[existing.state].Name)) return
      if (AIRRE.test(Name)) { cells.set(k, { state: stateFor("minecraft:cave_air"), pos: [wx, wy, wz] }) ; return }
      const cell = { state: stateFor(Name, Properties), pos: [wx, wy, wz] }
      if (nbt) cell.nbt = nbt
      cells.set(k, cell)
    }
    const solidAt = (wx, wy, wz) => {
      const c = cells.get(key(wx, wy, wz))
      return !!c && !AIRRE.test(palette[c.state].Name)
    }

    for (const [p, index] of kept) {
      const r = rnd(mix(baseSeed, index))
      const rni = n => Math.floor(r() * n)
      const b = p.box

      if (p.kind === "room") {
        for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) place(x, b.minY, z, "minecraft:dirt")
        const carve = (x0, y0, z0, x1, y1, z1) => {
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) place(x, y, z, "minecraft:cave_air")
        }
        carve(b.minX, b.minY + 1, b.minZ, b.maxX, Math.min(b.minY + 3, b.maxY), b.maxZ)
        for (const e of p.entrances) carve(e.minX, e.maxY - 2, e.minZ, e.maxX, e.maxY, e.maxZ)
        // generateUpperHalfSphere dome
        const dx = b.maxX - b.minX + 1, dy = b.maxY - (b.minY + 4) + 1, dz = b.maxZ - b.minZ + 1
        const cx = b.minX + dx / 2, cz = b.minZ + dz / 2
        for (let y = b.minY + 4; y <= b.maxY; y++) for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
          const nY = (y - (b.minY + 4)) / dy, nX = (x - cx) / (dx * 0.5), nZ = (z - cz) / (dz * 0.5)
          if (nX * nX + nY * nY + nZ * nZ <= 1.05) place(x, y, z, "minecraft:cave_air")
        }
        continue
      }

      if (p.kind === "stairs") {
        // the game only carves (treads are terrain); fabricate stone under each column
        const w = (x, y, z, s, props) => placeOriented(p, x, y, z, s, props)
        const lowest = new Map()
        const carve = (x0, y0, z0, x1, y1, z1) => {
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
            w(x, y, z, "minecraft:cave_air")
            const k = x + "," + z
            if (y < (lowest.get(k) ?? Infinity)) lowest.set(k, y)
          }
        }
        carve(0, 5, 0, 2, 7, 1)
        carve(0, 0, 7, 2, 2, 8)
        for (let i = 0; i < 5; i++) carve(0, 5 - i - (i < 4 ? 1 : 0), 2 + i, 2, 7 - i, 2 + i)
        for (const [k, y] of lowest) {
          const [x, z] = k.split(",").map(Number)
          const [wx, wy, wz] = orient(p, x, y - 1, z)
          if (!cells.has(key(wx, wy, wz))) place(wx, wy, wz, "minecraft:stone")
        }
        continue
      }

      if (p.kind === "crossing") {
        const carve = (x0, y0, z0, x1, y1, z1) => {
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) place(x, y, z, "minecraft:cave_air")
        }
        if (p.twoFloored) {
          carve(b.minX + 1, b.minY, b.minZ, b.maxX - 1, b.minY + 2, b.maxZ)
          carve(b.minX, b.minY, b.minZ + 1, b.maxX, b.minY + 2, b.maxZ - 1)
          carve(b.minX + 1, b.maxY - 2, b.minZ, b.maxX - 1, b.maxY, b.maxZ)
          carve(b.minX, b.maxY - 2, b.minZ + 1, b.maxX, b.maxY, b.maxZ - 1)
          carve(b.minX + 1, b.minY + 3, b.minZ + 1, b.maxX - 1, b.minY + 3, b.maxZ - 1)
        } else {
          carve(b.minX + 1, b.minY, b.minZ, b.maxX - 1, b.maxY, b.maxZ)
          carve(b.minX, b.minY, b.minZ + 1, b.maxX, b.maxY, b.maxZ - 1)
        }
        // placeSupportPillar skips corners with air above
        for (const [px, pz] of [[b.minX + 1, b.minZ + 1], [b.minX + 1, b.maxZ - 1], [b.maxX - 1, b.minZ + 1], [b.maxX - 1, b.maxZ - 1]]) {
          if (cave?.has(px + "," + pz) && !solidAt(px, b.maxY + 1, pz)) continue
          for (let y = b.minY; y <= b.maxY; y++) place(px, y, pz, T.planks)
        }
        for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
          if (!solidAt(x, b.minY - 1, z)) place(x, b.minY - 1, z, T.planks)
        }
        continue
      }

      // ---- corridor
      const len = p.sections * 5 - 1
      const w = (x, y, z, s, props, nbt) => placeOriented(p, x, y, z, s, props, nbt)
      const inCave = (x, z) => {
        if (p.suspended != null) return p.suspended
        const [wx, , wz] = orient(p, x, 0, z)
        return cave?.has(wx + "," + wz) ?? false
      }
      for (let y = 0; y <= 1; y++) for (let x = 0; x <= 2; x++) for (let z = 0; z <= len; z++) w(x, y, z, "minecraft:cave_air")
      for (let x = 0; x <= 2; x++) for (let z = 0; z <= len; z++) { if (r() <= 0.8) w(x, 2, z, "minecraft:cave_air") }
      if (p.spider) {
        for (let y = 0; y <= 1; y++) for (let x = 0; x <= 2; x++) for (let z = 0; z <= len; z++) { if (r() <= 0.6) w(x, y, z, "minecraft:cobweb") }
      }
      let placedSpider = false
      for (let s = 0; s < p.sections; s++) {
        const z = 2 + s * 5
        // placeSupport: isSupportingBox fails over cave air, no support
        if (![0, 1, 2].some(x => inCave(x, z))) {
          for (let y = 0; y <= 1; y++) {
            w(0, y, z, T.fence, { west: "true" })
            w(2, y, z, T.fence, { east: "true" })
          }
          if (rni(4) === 0) {
            w(0, 2, z, T.planks)
            w(2, 2, z, T.planks)
          } else {
            for (let x = 0; x <= 2; x++) w(x, 2, z, T.planks)
            if (r() < 0.05) w(1, 2, z - 1, "minecraft:wall_torch", { facing: "south" })
            if (r() < 0.05) w(1, 2, z + 1, "minecraft:wall_torch", { facing: "north" })
          }
        }
        const web = (x, y, wz, prob) => { if (r() < prob && sturdyNeighbours(p, x, y, wz)) w(x, y, wz, "minecraft:cobweb") }
        web(0, 2, z - 1, 0.1); web(2, 2, z - 1, 0.1); web(0, 2, z + 1, 0.1); web(2, 2, z + 1, 0.1)
        web(0, 2, z - 2, 0.05); web(2, 2, z - 2, 0.05); web(0, 2, z + 2, 0.05); web(2, 2, z + 2, 0.05)
        if (rni(100) === 0) chestMinecart(p, 2, 0, z - 1, r)
        if (rni(100) === 0) chestMinecart(p, 0, 0, z + 1, r)
        if (p.spider && !placedSpider) {
          const nz = z - 1 + rni(3)
          placedSpider = true
          w(1, 0, nz, "minecraft:spawner", null, { id: "minecraft:mob_spawner", SpawnData: { entity: { id: "minecraft:cave_spider" } } })
        }
      }
      for (let x = 0; x <= 2; x++) for (let z = 0; z <= len; z++) {
        const [wx, wy, wz] = orient(p, x, -1, z)
        if (!solidAt(wx, wy, wz)) place(wx, wy, wz, T.planks)
      }
      if (p.hasRails) {
        for (let z = 0; z <= len; z++) {
          const [fx, fy, fz] = orient(p, 1, -1, z)
          if (solidAt(fx, fy, fz) && r() < 0.7) w(1, 0, z, "minecraft:rail", { shape: railShape(p, "north_south") })
        }
      }
      // placeDoubleLowerOrUpperSupport / fillPillarDownOrChainUp
      const pillarOrChain = (wx, wy, wz) => {
        const blockedAt = y => y >= ceilY || solidAt(wx, y, wz)
        let down = true, up = true
        for (let j = 1; down || up; j++) {
          if (down) {
            if (blockedAt(wy - j)) {
              for (let y = wy - j + 1; y < wy; y++) place(wx, y, wz, T.wood)
              return
            }
            down = j <= 20
          }
          if (up) {
            if (blockedAt(wy + j)) {
              place(wx, wy + 1, wz, T.fence)
              for (let y = wy + 2; y < wy + j; y++) place(wx, y, wz, "minecraft:iron_chain", { axis: "y" })
              return
            }
            up = j <= 50
          }
        }
      }
      const doubleSupport = z => {
        for (const x of [0, 2]) {
          const [wx, wy, wz] = orient(p, x, -1, z)
          const floor = cells.get(key(wx, wy, wz))
          if (floor && palette[floor.state].Name === T.planks) pillarOrChain(wx, wy, wz)
        }
      }
      doubleSupport(2)
      if (p.sections > 1) doubleSupport(len - 2)
    }

    function orient(p, x, y, z) {
      const b = p.box
      switch (p.dir) {
        case "north": return [b.minX + x, b.minY + y, b.maxZ - z]
        case "south": return [b.minX + x, b.minY + y, b.minZ + z]
        case "west": return [b.maxX - z, b.minY + y, b.minZ + x]
        default: return [b.minX + z, b.minY + y, b.minZ + x]
      }
    }

    function placeOriented(p, x, y, z, Name, Properties, nbt) {
      const [wx, wy, wz] = orient(p, x, y, z)
      let props = Properties
      if (props) {
        if (p.dir === "south" || p.dir === "west") props = mirrorState(props, "lr")
        if (p.dir === "west" || p.dir === "east") props = rotateState(props, 1)
      }
      place(wx, wy, wz, Name, props, nbt)
    }

    function railShape(p, shape) {
      return p.dir === "west" || p.dir === "east" ? (shape === "north_south" ? "east_west" : "north_south") : shape
    }

    function sturdyNeighbours(p, x, y, z) {
      const [wx, wy, wz] = orient(p, x, y, z)
      let n = 0
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        if (solidAt(wx + dx, wy + dy, wz + dz) && ++n >= 2) return true
      }
      return false
    }

    function chestMinecart(p, x, y, z, r) {
      const [wx, wy, wz] = orient(p, x, y, z)
      if (solidAt(wx, wy, wz)) return
      const below = cells.get(key(wx, wy - 1, wz))
      if (!below || AIRRE.test(palette[below.state].Name)) return
      place(wx, wy, wz, "minecraft:rail", { shape: railShape(p, r() < 0.5 ? "north_south" : "east_west") })
      entities.push({ pos: [wx + 0.5, wy + 0.5, wz + 0.5], nbt: { id: "minecraft:chest_minecart", LootTable: "minecraft:chests/abandoned_mineshaft" } })
    }

    // ---- normalise to a structure

    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const c of cells.values()) {
      if (AIRRE.test(palette[c.state].Name)) continue
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], c.pos[i]); hi[i] = Math.max(hi[i], c.pos[i]) }
    }
    if (lo[0] > hi[0]) return { structure: { size: [1, 1, 1], palette: [{ Name: "minecraft:air" }], blocks: [{ state: 0, pos: [0, 0, 0] }], entities: [], anchor: [0, 0, 0] }, maxDepth: naturalMax }
    const blocks = []
    for (const c of cells.values()) {
      if (AIRRE.test(palette[c.state].Name)) continue
      const block = { state: c.state, pos: [c.pos[0] - lo[0], c.pos[1] - lo[1], c.pos[2] - lo[2]] }
      if (c.nbt) block.nbt = c.nbt
      blocks.push(block)
    }
    const outEntities = entities
      .filter(e => e.pos[0] >= lo[0] - 1 && e.pos[0] <= hi[0] + 1)
      .map(e => ({ ...e, pos: [e.pos[0] - lo[0], e.pos[1] - lo[1], e.pos[2] - lo[2]] }))
    let caveWire = null
    if (cave) {
      caveWire = {
        cells: [...cave].map(k => k.split(",").map(Number)).map(([x, z]) => [x - lo[0], z - lo[2]]),
        y0: 0,
        y1: ceilY - lo[1]
      }
    }

    // anchor on the entry piece's corner so the camera tracks it
    const eb = pieces[0].box
    return {
      structure: {
        size: [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1],
        palette, blocks, entities: outEntities,
        anchor: [eb.minX - lo[0], eb.minY - lo[1], eb.minZ - lo[2]],
        ...caveWire && { cave: caveWire }
      },
      maxDepth: naturalMax
    }
  }
}

export const runMineshaft = makeMineshaft("normal")
export const runMineshaftMesa = makeMineshaft("mesa")
export const runMineshaftRoom = makeMineshaft("normal", "room")
export const runMineshaftRoomMesa = makeMineshaft("mesa", "room")

export const mineshaftPieceGens = {}
for (const type of ["normal", "mesa"]) {
  for (const sections of [2, 3, 4]) {
    mineshaftPieceGens[`mineshaft_${type}_corridor_${sections * 5}`] = makeMineshaft(type, "corridor", sections)
    mineshaftPieceGens[`mineshaft_${type}_spider_corridor_${sections * 5}`] = makeMineshaft(type, "spider_corridor", sections)
    mineshaftPieceGens[`mineshaft_${type}_suspended_corridor_${sections * 5}`] = makeMineshaft(type, "suspended_corridor", sections)
  }
}
