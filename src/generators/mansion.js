import { DIR, OPP, add3, rnd, rotDir, rotPos, shuffle } from "../transforms.js"
import { combine } from "../combine.js"

// woodland mansion (WoodlandMansionPieces): an 11x11 grid is flood-filled into
// corridors + rooms across three floors, then a piece placer walks that grid
// emitting wall / floor / carpet / room / roof templates: with rotation AND
// mirror (rooms mirror to face their door). it's assembled in one pass with no
// recursion depth, so there are no steps: it just builds whole. mob-spawn markers
// are dropped; the ChestN/E/S/W markers become facing loot chests (via combine).
export async function runMansion(loadStruct, { seed } = {}) {
  const rand = seed == null ? Math.random : rnd(seed)
  const ni = n => Math.floor(rand() * n), nb = () => rand() < 0.5
  const getR = (a, r) => (a + r) & 3                          // Rotation.getRotated (NONE0 CW1 180=2 CCW3)
  const ROT = 0                                               // global placement rotation

  // grid Direction helpers (grid x = Direction stepX, grid y = stepZ)
  const stepX = d => DIR[d][0], stepZ = d => DIR[d][2]
  const cw = d => rotDir(d, 1), ccw = d => rotDir(d, 3), opp = d => OPP[d]
  const from2D = n => ["south", "west", "north", "east"][n]   // Direction.from2DDataValue
  const HPLANE = ["north", "south", "west", "east"]           // Direction.Plane.HORIZONTAL order

  class Grid {
    constructor(w, h, out) { this.width = w; this.height = h; this.out = out; this.g = Array.from({ length: w }, () => new Array(h).fill(0)) }
    set(x, y, v) { if (x >= 0 && x < this.width && y >= 0 && y < this.height) this.g[x][y] = v }
    rect(x0, y0, x1, y1, v) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, v) }
    get(x, y) { return x >= 0 && x < this.width && y >= 0 && y < this.height ? this.g[x][y] : this.out }
    setif(x, y, ifv, v) { if (this.get(x, y) === ifv) this.set(x, y, v) }
    edgesTo(x, y, ifv) { return this.get(x - 1, y) === ifv || this.get(x + 1, y) === ifv || this.get(x, y + 1) === ifv || this.get(x, y - 1) === ifv }
  }
  const isHouse = (grid, x, y) => { const v = grid.get(x, y); return v === 1 || v === 2 || v === 3 || v === 4 }

  const recursiveCorridor = (grid, x, y, heading, depth) => {
    if (depth <= 0) return
    grid.set(x, y, 1)
    grid.setif(x + stepX(heading), y + stepZ(heading), 0, 1)
    for (let a = 0; a < 8; a++) {
      const nd = from2D(ni(4))
      if (nd !== opp(heading) && (nd !== "east" || !nb())) {
        const nx = x + stepX(heading), nyy = y + stepZ(heading)
        if (grid.get(nx + stepX(nd), nyy + stepZ(nd)) === 0 && grid.get(nx + stepX(nd) * 2, nyy + stepZ(nd) * 2) === 0) {
          recursiveCorridor(grid, x + stepX(heading) + stepX(nd), y + stepZ(heading) + stepZ(nd), nd, depth - 1)
          break
        }
      }
    }
    const c = cw(heading), cc = ccw(heading)
    grid.setif(x + stepX(c), y + stepZ(c), 0, 2)
    grid.setif(x + stepX(cc), y + stepZ(cc), 0, 2)
    grid.setif(x + stepX(heading) + stepX(c), y + stepZ(heading) + stepZ(c), 0, 2)
    grid.setif(x + stepX(heading) + stepX(cc), y + stepZ(heading) + stepZ(cc), 0, 2)
    grid.setif(x + stepX(heading) * 2, y + stepZ(heading) * 2, 0, 2)
    grid.setif(x + stepX(c) * 2, y + stepZ(c) * 2, 0, 2)
    grid.setif(x + stepX(cc) * 2, y + stepZ(cc) * 2, 0, 2)
  }
  const cleanEdges = grid => {
    let touched = false
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      if (grid.get(x, y) !== 0) continue
      let dn = (isHouse(grid, x + 1, y) ? 1 : 0) + (isHouse(grid, x - 1, y) ? 1 : 0) + (isHouse(grid, x, y + 1) ? 1 : 0) + (isHouse(grid, x, y - 1) ? 1 : 0)
      if (dn >= 3) { grid.set(x, y, 2); touched = true }
      else if (dn === 2) {
        const diag = (isHouse(grid, x + 1, y + 1) ? 1 : 0) + (isHouse(grid, x - 1, y + 1) ? 1 : 0) + (isHouse(grid, x + 1, y - 1) ? 1 : 0) + (isHouse(grid, x - 1, y - 1) ? 1 : 0)
        if (diag <= 1) { grid.set(x, y, 2); touched = true }
      }
    }
    return touched
  }

  // build the three floor grids (MansionGrid)
  const entranceX = 7, entranceY = 4
  const baseGrid = new Grid(11, 11, 5)
  baseGrid.rect(entranceX, entranceY, entranceX + 1, entranceY + 1, 3)
  baseGrid.rect(entranceX - 1, entranceY, entranceX - 1, entranceY + 1, 2)
  baseGrid.rect(entranceX + 2, entranceY - 2, entranceX + 3, entranceY + 3, 5)
  baseGrid.rect(entranceX + 1, entranceY - 2, entranceX + 1, entranceY - 1, 1)
  baseGrid.rect(entranceX + 1, entranceY + 2, entranceX + 1, entranceY + 3, 1)
  baseGrid.set(entranceX - 1, entranceY - 1, 1)
  baseGrid.set(entranceX - 1, entranceY + 2, 1)
  baseGrid.rect(0, 0, 11, 1, 5)
  baseGrid.rect(0, 9, 11, 11, 5)
  recursiveCorridor(baseGrid, entranceX, entranceY - 2, "west", 6)
  recursiveCorridor(baseGrid, entranceX, entranceY + 3, "west", 6)
  recursiveCorridor(baseGrid, entranceX - 2, entranceY - 1, "west", 3)
  recursiveCorridor(baseGrid, entranceX - 2, entranceY + 2, "west", 3)
  while (cleanEdges(baseGrid)) { }

  const floorRooms = [new Grid(11, 11, 5), new Grid(11, 11, 5), new Grid(11, 11, 5)]
  const isRoomId = (x, y, floor, roomId) => (floorRooms[floor].get(x, y) & 65535) === roomId
  const get1x2RoomDirection = (x, y, floor, roomId) => { for (const d of HPLANE) if (isRoomId(x + stepX(d), y + stepZ(d), floor, roomId)) return d; return null }

  const identifyRooms = (from, roomGrid) => {
    const list = []
    for (let y = 0; y < from.height; y++) for (let x = 0; x < from.width; x++) if (from.get(x, y) === 2) list.push([x, y])
    const shuffled = shuffle(list, rand)
    let roomId = 10
    for (const [x, y] of shuffled) {
      if (roomGrid.get(x, y) !== 0) continue
      let x0 = x, x1 = x, y0 = y, y1 = y, type = 65536
      if (roomGrid.get(x + 1, y) === 0 && roomGrid.get(x, y + 1) === 0 && roomGrid.get(x + 1, y + 1) === 0 && from.get(x + 1, y) === 2 && from.get(x, y + 1) === 2 && from.get(x + 1, y + 1) === 2) { x1++; y1++; type = 262144 }
      else if (roomGrid.get(x - 1, y) === 0 && roomGrid.get(x, y + 1) === 0 && roomGrid.get(x - 1, y + 1) === 0 && from.get(x - 1, y) === 2 && from.get(x, y + 1) === 2 && from.get(x - 1, y + 1) === 2) { x0--; y1++; type = 262144 }
      else if (roomGrid.get(x - 1, y) === 0 && roomGrid.get(x, y - 1) === 0 && roomGrid.get(x - 1, y - 1) === 0 && from.get(x - 1, y) === 2 && from.get(x, y - 1) === 2 && from.get(x - 1, y - 1) === 2) { x0--; y0--; type = 262144 }
      else if (roomGrid.get(x + 1, y) === 0 && from.get(x + 1, y) === 2) { x1++; type = 131072 }
      else if (roomGrid.get(x, y + 1) === 0 && from.get(x, y + 1) === 2) { y1++; type = 131072 }
      else if (roomGrid.get(x - 1, y) === 0 && from.get(x - 1, y) === 2) { x0--; type = 131072 }
      else if (roomGrid.get(x, y - 1) === 0 && from.get(x, y - 1) === 2) { y0--; type = 131072 }
      let doorX = nb() ? x0 : x1, doorY = nb() ? y0 : y1, doorFlag = 2097152
      if (!from.edgesTo(doorX, doorY, 1)) {
        doorX = doorX === x0 ? x1 : x0; doorY = doorY === y0 ? y1 : y0
        if (!from.edgesTo(doorX, doorY, 1)) {
          doorY = doorY === y0 ? y1 : y0
          if (!from.edgesTo(doorX, doorY, 1)) {
            doorX = doorX === x0 ? x1 : x0; doorY = doorY === y0 ? y1 : y0
            if (!from.edgesTo(doorX, doorY, 1)) { doorFlag = 0; doorX = x0; doorY = y0 }
          }
        }
      }
      for (let ry = y0; ry <= y1; ry++) for (let rx = x0; rx <= x1; rx++) roomGrid.set(rx, ry, (rx === doorX && ry === doorY) ? (1048576 | doorFlag | type | roomId) : (type | roomId))
      roomId++
    }
  }
  identifyRooms(baseGrid, floorRooms[0])
  identifyRooms(baseGrid, floorRooms[1])
  floorRooms[0].rect(entranceX + 1, entranceY, entranceX + 1, entranceY + 1, 8388608)
  floorRooms[1].rect(entranceX + 1, entranceY, entranceX + 1, entranceY + 1, 8388608)

  const thirdGrid = new Grid(baseGrid.width, baseGrid.height, 5)
  // setupThirdFloor: pick a 1x2 door room on floor 1 to become the third-floor stub
  {
    const floor = floorRooms[1], pot = []
    for (let y = 0; y < thirdGrid.height; y++) for (let x = 0; x < thirdGrid.width; x++) {
      const rd = floor.get(x, y)
      if ((rd & 983040) === 131072 && (rd & 2097152) === 2097152) pot.push([x, y])
    }
    if (pot.length === 0) thirdGrid.rect(0, 0, thirdGrid.width, thirdGrid.height, 5)
    else {
      const [px, py] = pot[ni(pot.length)]
      const rd = floor.get(px, py)
      floor.set(px, py, rd | 4194304)
      const roomDir = get1x2RoomDirection(px, py, 1, rd & 65535)
      const ex = px + stepX(roomDir), ey = py + stepZ(roomDir)
      for (let y = 0; y < thirdGrid.height; y++) for (let x = 0; x < thirdGrid.width; x++) {
        if (!isHouse(baseGrid, x, y)) thirdGrid.set(x, y, 5)
        else if (x === px && y === py) thirdGrid.set(x, y, 3)
        else if (x === ex && y === ey) { thirdGrid.set(x, y, 3); floorRooms[2].set(x, y, 8388608) }
      }
      const corridors = []
      for (const d of HPLANE) if (thirdGrid.get(ex + stepX(d), ey + stepZ(d)) === 0) corridors.push(d)
      if (corridors.length === 0) { thirdGrid.rect(0, 0, thirdGrid.width, thirdGrid.height, 5); floor.set(px, py, rd) }
      else {
        const cd = corridors[ni(corridors.length)]
        recursiveCorridor(thirdGrid, ex + stepX(cd), ey + stepZ(cd), cd, 4)
        while (cleanEdges(thirdGrid)) { }
      }
    }
  }
  identifyRooms(thirdGrid, floorRooms[2])

  // ---- piece placer (MansionPiecePlacer.createMansion) ----------------------
  const pieces = []                                          // { name, pos, rot, mir }
  const origin = [0, 0, 0]
  const mv = (pos, baseDir, rotK, n) => { const d = rotDir(baseDir, rotK); return [pos[0] + DIR[d][0] * n, pos[1] + DIR[d][1] * n, pos[2] + DIR[d][2] * n] }
  const up = (pos, n) => [pos[0], pos[1] + n, pos[2]]
  const addPiece = (name, pos, rot, mir) => pieces.push({ name, pos, rot, mir })

  const startX = entranceX + 1, startY = entranceY + 1
  const roomColl = [
    { g1x1: () => "1x1_a" + (ni(5) + 1), g1x1s: () => "1x1_as" + (ni(4) + 1), g1x2side: () => "1x2_a" + (ni(9) + 1), g1x2front: () => "1x2_b" + (ni(5) + 1), g1x2s: () => "1x2_s" + (ni(2) + 1), g2x2: () => "2x2_a" + (ni(4) + 1), g2x2s: () => "2x2_s1" },
    { g1x1: () => "1x1_b" + (ni(5) + 1), g1x1s: () => "1x1_as" + (ni(4) + 1), g1x2side: s => s ? "1x2_c_stairs" : "1x2_c" + (ni(4) + 1), g1x2front: s => s ? "1x2_d_stairs" : "1x2_d" + (ni(5) + 1), g1x2s: () => "1x2_se" + (ni(1) + 1), g2x2: () => "2x2_b" + (ni(5) + 1), g2x2s: () => "2x2_s1" },
  ]
  roomColl[2] = roomColl[1]                                  // ThirdFloorRoomCollection extends Second (identical)

  const zeroPosT = (pos, mir, k, sx, sz) => {
    sx--; sz--
    const i = mir === "fb" ? sx : 0, j = mir === "lr" ? sz : 0
    let off
    switch (k & 3) { case 3: off = [j, 0, sx - i]; break; case 1: off = [sz - j, 0, i]; break; case 2: off = [sx - i, 0, sz - j]; break; default: off = [i, 0, j] }
    return [pos[0] + off[0], pos[1] + off[1], pos[2] + off[2]]
  }

  const traverseWallPiece = data => { addPiece(data.wallType, mv(data.position, "east", data.rot, 7), data.rot); data.position = mv(data.position, "south", data.rot, 8) }
  const traverseTurn = data => {
    data.position = mv(data.position, "south", data.rot, -1)
    addPiece("wall_corner", data.position, data.rot)
    data.position = mv(data.position, "south", data.rot, -7)
    data.position = mv(data.position, "west", data.rot, -6)
    data.rot = getR(data.rot, 1)
  }
  const traverseInnerTurn = data => { data.position = mv(data.position, "south", data.rot, 6); data.position = mv(data.position, "east", data.rot, 8); data.rot = getR(data.rot, 3) }
  const traverseOuterWalls = (data, grid, gridDir0, sx, sy, ex, ey) => {
    let gx = sx, gy = sy, gridDir = gridDir0
    const startDir = gridDir0
    do {
      if (!isHouse(grid, gx + stepX(gridDir), gy + stepZ(gridDir))) {
        traverseTurn(data); gridDir = cw(gridDir)
        if (gx !== ex || gy !== ey || startDir !== gridDir) traverseWallPiece(data)
      } else if (isHouse(grid, gx + stepX(gridDir), gy + stepZ(gridDir)) && isHouse(grid, gx + stepX(gridDir) + stepX(ccw(gridDir)), gy + stepZ(gridDir) + stepZ(ccw(gridDir)))) {
        traverseInnerTurn(data); gx += stepX(gridDir); gy += stepZ(gridDir); gridDir = ccw(gridDir)
      } else {
        gx += stepX(gridDir); gy += stepZ(gridDir)
        if (gx !== ex || gy !== ey || startDir !== gridDir) traverseWallPiece(data)
      }
    } while (gx !== ex || gy !== ey || startDir !== gridDir)
  }

  const addRoom1x1 = (roomPos, doorDir, rooms) => {
    let pieceRot = 0, roomType = rooms.g1x1()
    if (doorDir !== "east") {
      if (doorDir === "north") pieceRot = getR(pieceRot, 3)
      else if (doorDir === "west") pieceRot = getR(pieceRot, 2)
      else if (doorDir === "south") pieceRot = getR(pieceRot, 1)
      else roomType = rooms.g1x1s()
    }
    let o = zeroPosT([1, 0, 0], undefined, pieceRot, 7, 7)
    pieceRot = getR(pieceRot, ROT)
    o = rotPos(o, ROT)
    addPiece(roomType, [roomPos[0] + o[0], roomPos[1], roomPos[2] + o[2]], pieceRot)
  }
  const addRoom1x2 = (roomPos, roomDir, doorDir, rooms, stairs) => {
    const side = () => rooms.g1x2side(stairs), front = () => rooms.g1x2front(stairs)
    const P = (baseDir, n, baseDir2, n2) => { let p = mv(roomPos, baseDir, ROT, n); if (baseDir2) p = mv(p, baseDir2, ROT, n2); return p }
    if (doorDir === "east" && roomDir === "south") addPiece(side(), P("east", 1), ROT)
    else if (doorDir === "east" && roomDir === "north") addPiece(side(), P("east", 1, "south", 6), ROT, "lr")
    else if (doorDir === "west" && roomDir === "north") addPiece(side(), P("east", 7, "south", 6), getR(ROT, 2))
    else if (doorDir === "west" && roomDir === "south") addPiece(side(), P("east", 7), ROT, "fb")
    else if (doorDir === "south" && roomDir === "east") addPiece(side(), P("east", 1), getR(ROT, 1), "lr")
    else if (doorDir === "south" && roomDir === "west") addPiece(side(), P("east", 7), getR(ROT, 1))
    else if (doorDir === "north" && roomDir === "west") addPiece(side(), P("east", 7, "south", 6), getR(ROT, 1), "fb")
    else if (doorDir === "north" && roomDir === "east") addPiece(side(), P("east", 1, "south", 6), getR(ROT, 3))
    else if (doorDir === "south" && roomDir === "north") addPiece(front(), P("east", 1, "north", 8), ROT)
    else if (doorDir === "north" && roomDir === "south") addPiece(front(), P("east", 7, "south", 14), getR(ROT, 2))
    else if (doorDir === "west" && roomDir === "east") addPiece(front(), P("east", 15), getR(ROT, 1))
    else if (doorDir === "east" && roomDir === "west") addPiece(front(), P("west", 7, "south", 6), getR(ROT, 3))
    else if (doorDir === "up" && roomDir === "east") addPiece(rooms.g1x2s(), P("east", 15), getR(ROT, 1))
    else if (doorDir === "up" && roomDir === "south") addPiece(rooms.g1x2s(), P("east", 1), ROT)
  }
  const addRoom2x2 = (roomPos, roomDir, doorDir, rooms) => {
    let east = 0, south = 0, rot = ROT, mir
    if (doorDir === "east" && roomDir === "south") east = -7
    else if (doorDir === "east" && roomDir === "north") { east = -7; south = 6; mir = "lr" }
    else if (doorDir === "north" && roomDir === "east") { east = 1; south = 14; rot = getR(ROT, 3) }
    else if (doorDir === "north" && roomDir === "west") { east = 7; south = 14; rot = getR(ROT, 3); mir = "lr" }
    else if (doorDir === "south" && roomDir === "west") { east = 7; south = -8; rot = getR(ROT, 1) }
    else if (doorDir === "south" && roomDir === "east") { east = 1; south = -8; rot = getR(ROT, 1); mir = "lr" }
    else if (doorDir === "west" && roomDir === "north") { east = 15; south = 6; rot = getR(ROT, 2) }
    else if (doorDir === "west" && roomDir === "south") { east = 15; mir = "fb" }
    let pos = mv(roomPos, "east", ROT, east)
    pos = mv(pos, "south", ROT, south)
    addPiece(rooms.g2x2(), pos, rot, mir)
  }
  const addRoom2x2Secret = (roomPos, rooms) => addPiece(rooms.g2x2s(), mv(roomPos, "east", ROT, 1), ROT)

  const createRoof = (roofOrigin, grid, aboveGrid) => {
    const at = (x, y) => { let p = mv(roofOrigin, "south", ROT, 8 + (y - startY) * 8); return mv(p, "east", ROT, (x - startX) * 8) }
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      const position = at(x, y), isAbove = aboveGrid != null && isHouse(aboveGrid, x, y)
      if (isHouse(grid, x, y) && !isAbove) {
        addPiece("roof", up(position, 3), ROT)
        if (!isHouse(grid, x + 1, y)) addPiece("roof_front", mv(position, "east", ROT, 6), ROT)
        if (!isHouse(grid, x - 1, y)) addPiece("roof_front", mv(position, "south", ROT, 7), getR(ROT, 2))
        if (!isHouse(grid, x, y - 1)) addPiece("roof_front", mv(position, "west", ROT, 1), getR(ROT, 3))
        if (!isHouse(grid, x, y + 1)) addPiece("roof_front", mv(mv(position, "east", ROT, 6), "south", ROT, 6), getR(ROT, 1))
      }
    }
    if (aboveGrid != null) for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      const position = at(x, y)
      if (isHouse(grid, x, y) && isHouse(aboveGrid, x, y)) {
        if (!isHouse(grid, x + 1, y)) addPiece("small_wall", mv(position, "east", ROT, 7), ROT)
        if (!isHouse(grid, x - 1, y)) addPiece("small_wall", mv(mv(position, "west", ROT, 1), "south", ROT, 6), getR(ROT, 2))
        if (!isHouse(grid, x, y - 1)) addPiece("small_wall", mv(position, "north", ROT, 1), getR(ROT, 3))
        if (!isHouse(grid, x, y + 1)) addPiece("small_wall", mv(mv(position, "east", ROT, 6), "south", ROT, 7), getR(ROT, 1))
        if (!isHouse(grid, x + 1, y)) {
          if (!isHouse(grid, x, y - 1)) addPiece("small_wall_corner", mv(mv(position, "east", ROT, 7), "north", ROT, 2), ROT)
          if (!isHouse(grid, x, y + 1)) addPiece("small_wall_corner", mv(mv(position, "east", ROT, 8), "south", ROT, 7), getR(ROT, 1))
        }
        if (!isHouse(grid, x - 1, y)) {
          if (!isHouse(grid, x, y - 1)) addPiece("small_wall_corner", mv(mv(position, "west", ROT, 2), "north", ROT, 1), getR(ROT, 3))
          if (!isHouse(grid, x, y + 1)) addPiece("small_wall_corner", mv(mv(position, "west", ROT, 1), "south", ROT, 8), getR(ROT, 2))
        }
      }
    }
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      const position = at(x, y), isAbove = aboveGrid != null && isHouse(aboveGrid, x, y)
      if (isHouse(grid, x, y) && !isAbove) {
        if (!isHouse(grid, x + 1, y)) {
          const p2 = mv(position, "east", ROT, 6)
          if (!isHouse(grid, x, y + 1)) addPiece("roof_corner", mv(p2, "south", ROT, 6), ROT)
          else if (isHouse(grid, x + 1, y + 1)) addPiece("roof_inner_corner", mv(p2, "south", ROT, 5), ROT)
          if (!isHouse(grid, x, y - 1)) addPiece("roof_corner", p2, getR(ROT, 3))
          else if (isHouse(grid, x + 1, y - 1)) addPiece("roof_inner_corner", mv(mv(position, "east", ROT, 9), "north", ROT, 2), getR(ROT, 1))
        }
        if (!isHouse(grid, x - 1, y)) {
          const p2 = position
          if (!isHouse(grid, x, y + 1)) addPiece("roof_corner", mv(p2, "south", ROT, 6), getR(ROT, 1))
          else if (isHouse(grid, x - 1, y + 1)) addPiece("roof_inner_corner", mv(mv(p2, "south", ROT, 8), "west", ROT, 3), getR(ROT, 3))
          if (!isHouse(grid, x, y - 1)) addPiece("roof_corner", p2, getR(ROT, 2))
          else if (isHouse(grid, x - 1, y - 1)) addPiece("roof_inner_corner", mv(p2, "south", ROT, 1), getR(ROT, 2))
        }
      }
    }
  }

  // createMansion
  const data = { position: origin.slice(), rotation: ROT, rot: ROT, wallType: "wall_flat" }
  addPiece("entrance", mv(data.position, "west", data.rot, 9), data.rot)
  data.position = mv(data.position, "south", data.rot, 16)
  const secondData = { position: up(data.position, 8), rot: data.rot, wallType: "wall_window" }
  traverseOuterWalls(data, baseGrid, "south", startX, startY, entranceX + 1, entranceY)
  traverseOuterWalls(secondData, baseGrid, "south", startX, startY, entranceX + 1, entranceY)
  const thirdData = { position: up(data.position, 19), rot: data.rot, wallType: "wall_window" }
  {
    let done = false
    for (let y = 0; y < thirdGrid.height && !done; y++) for (let x = thirdGrid.width - 1; x >= 0 && !done; x--) {
      if (isHouse(thirdGrid, x, y)) {
        thirdData.position = mv(thirdData.position, "south", ROT, 8 + (y - startY) * 8)
        thirdData.position = mv(thirdData.position, "east", ROT, (x - startX) * 8)
        traverseWallPiece(thirdData)
        traverseOuterWalls(thirdData, thirdGrid, "south", x, y, x, y)
        done = true
      }
    }
  }
  createRoof(up(origin, 16), baseGrid, thirdGrid)
  createRoof(up(origin, 27), thirdGrid, null)

  for (let floorNum = 0; floorNum < 3; floorNum++) {
    const floorOrigin = up(origin, 8 * floorNum + (floorNum === 2 ? 3 : 0))
    const rooms = floorRooms[floorNum], grid = floorNum === 2 ? thirdGrid : baseGrid
    const southPiece = floorNum === 0 ? "carpet_south_1" : "carpet_south_2"
    const westPiece = floorNum === 0 ? "carpet_west_1" : "carpet_west_2"
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      if (grid.get(x, y) !== 1) continue
      let pos = mv(floorOrigin, "south", ROT, 8 + (y - startY) * 8)
      pos = mv(pos, "east", ROT, (x - startX) * 8)
      addPiece("corridor_floor", pos, ROT)
      if (grid.get(x, y - 1) === 1 || (rooms.get(x, y - 1) & 8388608) === 8388608) addPiece("carpet_north", up(mv(pos, "east", ROT, 1), 1), ROT)
      if (grid.get(x + 1, y) === 1 || (rooms.get(x + 1, y) & 8388608) === 8388608) addPiece("carpet_east", up(mv(mv(pos, "south", ROT, 1), "east", ROT, 5), 1), ROT)
      if (grid.get(x, y + 1) === 1 || (rooms.get(x, y + 1) & 8388608) === 8388608) addPiece(southPiece, mv(mv(pos, "south", ROT, 5), "west", ROT, 1), ROT)
      if (grid.get(x - 1, y) === 1 || (rooms.get(x - 1, y) & 8388608) === 8388608) addPiece(westPiece, mv(mv(pos, "west", ROT, 1), "north", ROT, 1), ROT)
    }
    const wallPiece = floorNum === 0 ? "indoors_wall_1" : "indoors_wall_2"
    const doorPiece = floorNum === 0 ? "indoors_door_1" : "indoors_door_2"
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      let thirdStart = floorNum === 2 && grid.get(x, y) === 3
      if (grid.get(x, y) !== 2 && !thirdStart) continue
      const rd = rooms.get(x, y), roomType = rd & 983040, roomId = rd & 65535
      thirdStart = thirdStart && (rd & 8388608) === 8388608
      const doorDirs = []
      if ((rd & 2097152) === 2097152) for (const d of HPLANE) if (grid.get(x + stepX(d), y + stepZ(d)) === 1) doorDirs.push(d)
      let doorDir = doorDirs.length ? doorDirs[ni(doorDirs.length)] : ((rd & 1048576) === 1048576 ? "up" : null)
      let roomPos = mv(floorOrigin, "south", ROT, 8 + (y - startY) * 8)
      roomPos = mv(roomPos, "east", ROT, -1 + (x - startX) * 8)
      if (isHouse(grid, x - 1, y) && !isRoomId(x - 1, y, floorNum, roomId)) addPiece(doorDir === "west" ? doorPiece : wallPiece, roomPos, ROT)
      if (grid.get(x + 1, y) === 1 && !thirdStart) addPiece(doorDir === "east" ? doorPiece : wallPiece, mv(roomPos, "east", ROT, 8), ROT)
      if (isHouse(grid, x, y + 1) && !isRoomId(x, y + 1, floorNum, roomId)) addPiece(doorDir === "south" ? doorPiece : wallPiece, mv(mv(roomPos, "south", ROT, 7), "east", ROT, 7), getR(ROT, 1))
      if (grid.get(x, y - 1) === 1 && !thirdStart) addPiece(doorDir === "north" ? doorPiece : wallPiece, mv(mv(roomPos, "north", ROT, 1), "east", ROT, 7), getR(ROT, 1))
      const coll = roomColl[floorNum]
      if (roomType === 65536) addRoom1x1(roomPos, doorDir, coll)
      else if (roomType === 131072 && doorDir != null) { const roomDir = get1x2RoomDirection(x, y, floorNum, roomId); addRoom1x2(roomPos, roomDir, doorDir, coll, (rd & 4194304) === 4194304) }
      else if (roomType === 262144 && doorDir != null && doorDir !== "up") { let roomDir = cw(doorDir); if (!isRoomId(x + stepX(roomDir), y + stepZ(roomDir), floorNum, roomId)) roomDir = opp(roomDir); addRoom2x2(roomPos, roomDir, doorDir, coll) }
      else if (roomType === 262144 && doorDir === "up") addRoom2x2Secret(roomPos, coll)
    }
  }

  // load every referenced template once, then flatten
  const names = [...new Set(pieces.map(p => p.name))]
  const tpl = {}
  for (const n of names) tpl[n] = await loadStruct("woodland_mansion/" + n)
  // mansion pieces use the STRUCTURE_BLOCK processor => air carves (doorways)
  return { structure: combine(pieces.filter(p => tpl[p.name]).map(p => ({ struct: tpl[p.name], rot: p.rot, off: p.pos, mir: p.mir, ow: true }))), maxDepth: 1 }
}
