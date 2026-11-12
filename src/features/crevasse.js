import { sampleInt } from "./providers.js"
import { DIR, HORIZ, REAL_AIR, strip } from "../transforms.js"

const MIN_Y = -63
const FLUID = /(^|:)(flowing_)?(water|lava)$/
const SHELL = HORIZ.map(dir => DIR[dir]).concat([DIR.down])
const f = Math.fround

function gaussian(rand) {
  const u = Math.max(rand(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

function namedBlock(pred) {
  const type = strip(pred?.type ?? "")
  if (type === "matching_blocks") return [pred.blocks].flat()[0] ?? null
  if (type !== "all_of" && type !== "any_of") return null
  for (const inner of pred.predicates ?? []) {
    const hit = namedBlock(inner)
    if (hit) return hit
  }
  return null
}

export async function crevasse(world, json, rand, resolvePlaced, ox, oy, oz, helpers) {
  const { testPredicate, contextualState } = helpers
  const named = namedBlock(json.carvable_blocks)
  const host = { id: !named ? "minecraft:packed_ice" : named.includes(":") ? named : "minecraft:" + named }
  const px = ox, py = oy - 1, pz = oz
  const written = new Set()
  const columns = new Map()
  const key = (x, y, z) => x + "," + y + "," + z
  const colKey = (x, z) => x + "," + z
  // empty-world adaptation: cells at or below the surface read as host until written, and only the shell hugging the carve is made real
  const view = { get: (x, y, z) => world.get(x, y, z) ?? (y <= py && y >= MIN_Y && !written.has(key(x, y, z)) ? host : undefined) }
  const idAt = (x, y, z) => strip(view.get(x, y, z)?.id ?? "air")
  const carvable = (x, y, z) => test(json.carvable_blocks, x, y, z, cell => cell?.id === host.id)
  const barrier = (x, y, z) => test(json.acceptable_barrier, x, y, z, cell => !!cell && !FLUID.test(cell.id))
  const bottomY = col => col.y - col.depth
  const containsY = (col, y) => y >= bottomY(col) && y <= col.y

  function test(pred, x, y, z, tagged) {
    const [dx, dy, dz] = pred.offset ?? [0, 0, 0]
    const tx = x + dx, ty = y + dy, tz = z + dz
    const type = strip(pred.type ?? "")
    if (type === "not") return !test(pred.predicate, tx, ty, tz, tagged)
    if (type === "all_of") return (pred.predicates ?? []).every(inner => test(inner, tx, ty, tz, tagged))
    if (type === "any_of") return (pred.predicates ?? []).some(inner => test(inner, tx, ty, tz, tagged))
    if (type === "matching_block_tag" && strip(pred.tag ?? "") !== "air") return tagged(view.get(tx, ty, tz))
    return testPredicate(view, pred, x, y, z)
  }

  function put(x, y, z, state) {
    written.add(key(x, y, z))
    if (!state || REAL_AIR.test(state.id)) world.remove(x, y, z)
    else world.set(x, y, z, state)
  }

  function hasFluid(x, y, z) {
    const cell = view.get(x, y, z)
    return !!cell && (FLUID.test(cell.id) || cell.properties?.waterlogged === "true")
  }

  function findSurface(cx, cy, cz, range) {
    let y = cy + Math.trunc(range / 2)
    let aboveEmpty = !view.get(cx, y + 1, cz)
    const minY = Math.max(MIN_Y, y - range)
    for (; y >= minY; y--) {
      const block = view.get(cx, y, cz)
      if (carvable(cx, y, cz) && aboveEmpty) return { y, block }
      aboveEmpty = !block
    }
    return null
  }

  function hasSteepNeighbor(col) {
    for (const dir of HORIZ) {
      const neighbor = columns.get(colKey(col.x + DIR[dir][0], col.z + DIR[dir][2]))
      if (neighbor && Math.abs(col.y - neighbor.y) > 1) return true
    }
    return false
  }

  function removeDisconnected() {
    const origin = columns.get(colKey(px, pz))
    if (!origin || hasSteepNeighbor(origin)) {
      columns.clear()
      return
    }
    const connected = [origin]
    const processed = new Set([colKey(px, pz)])
    for (let i = 0; i < connected.length; i++) {
      const col = connected[i]
      for (const dir of HORIZ) {
        const k = colKey(col.x + DIR[dir][0], col.z + DIR[dir][2])
        const neighbor = columns.get(k)
        if (!neighbor || processed.has(k) || hasSteepNeighbor(neighbor)) continue
        connected.push(neighbor)
        processed.add(k)
      }
    }
    columns.clear()
    for (const col of connected) columns.set(colKey(col.x, col.z), col)
  }

  function appendBranch(branchLength, carveDepth, yaw) {
    let cursorX = px, cursorZ = pz, previousY = py, yawAcceleration = 0
    for (let step = 0; step < branchLength; step++) {
      cursorX += Math.cos(yaw)
      cursorZ += Math.sin(yaw)
      const turnDirection = gaussian(rand)
      const turnMagnitude = rand()
      yawAcceleration = yawAcceleration * 0.5 + turnDirection * turnMagnitude * json.twistiness
      yaw += yawAcceleration * json.turn_factor
      const blockX = Math.floor(cursorX), blockZ = Math.floor(cursorZ)
      const surface = findSurface(blockX, previousY, blockZ, json.cursor_surface_search_range)
      if (!surface) continue
      const taper = f(1 - f(f(step / branchLength) * f(json.tapering)))
      const radius = Math.max(f(f(json.max_width * 0.5) * taper), 0.5)
      const radiusSquared = f(radius * radius)
      const maxDepth = Math.max(Math.trunc(f(carveDepth * taper)), 1)
      const expanded = Math.ceil(radius)
      for (let x = blockX - expanded; x <= blockX + expanded; x++) {
        for (let z = blockZ - expanded; z <= blockZ + expanded; z++) {
          const dx = x - blockX, dz = z - blockZ
          if (dx * dx + dz * dz > radiusSquared || columns.has(colKey(x, z))) continue
          const found = findSurface(x, surface.y, z, json.column_surface_search_range)
          if (!found) continue
          let depth = 1
          for (let y = found.y - 1; depth < maxDepth && carvable(x, y, z); y--) depth++
          columns.set(colKey(x, z), { x, y: found.y, z, block: found.block, depth: depth - 1 })
        }
      }
      previousY = surface.y
    }
  }

  function sealSides(col, y, placed) {
    for (const dir of HORIZ) {
      const nx = col.x + DIR[dir][0], nz = col.z + DIR[dir][2]
      if (barrier(nx, y, nz)) continue
      const neighbor = columns.get(colKey(nx, nz))
      if (neighbor && containsY(neighbor, y)) continue
      if (idAt(nx, y, nz) !== placed) put(nx, y, nz, col.block)
    }
  }

  function carveColumn(col, fillLevel) {
    const bottom = bottomY(col)
    let carved = false
    for (let y = col.y; y >= bottom; y--) {
      const fill = contextualState(view, json.fill_block, rand, col.x, y, col.z)
      const shouldFill = !!fill && y <= fillLevel
      if (!shouldFill && HORIZ.some(dir => hasFluid(col.x + DIR[dir][0], y, col.z + DIR[dir][2]))) break
      const placed = shouldFill ? strip(fill.id) : "air"
      sealSides(col, y, placed)
      put(col.x, y, col.z, shouldFill ? fill : null)
      if (shouldFill && y === bottom && !barrier(col.x, y - 1, col.z) && idAt(col.x, y - 1, col.z) !== placed) put(col.x, y - 1, col.z, col.block)
      carved = true
    }
    if (!carved) return
    const surface = contextualState(view, json.surface_block, rand, col.x, col.y, col.z)
    if (surface) put(col.x, col.y, col.z, surface)
  }

  const carveDepth = sampleInt(json.carve_depth, rand)
  if (py <= MIN_Y + carveDepth) return
  const branchLength = Math.trunc(json.max_length / 2)
  const yaw = rand() * f(Math.PI * 2)
  const fillDepth = sampleInt(json.fill_depth, rand)
  for (let direction = 0; direction < 2; direction++) appendBranch(branchLength, carveDepth, yaw + direction * f(Math.PI))
  removeDisconnected()
  if (columns.size < json.min_footprint) return
  const sorted = Array.from(columns.values()).sort((a, b) => a.x - b.x || a.z - b.z)
  const fillLevel = Math.min(py - fillDepth, Math.min(...sorted.map(col => col.y)) - 1)
  for (const col of sorted) carveColumn(col, fillLevel)
  for (const col of sorted) {
    for (let y = col.y; y >= bottomY(col) && written.has(key(col.x, y, col.z)); y--) {
      for (const [dx, dy, dz] of SHELL) {
        if (view.get(col.x + dx, y + dy, col.z + dz) === host) world.set(col.x + dx, y + dy, col.z + dz, host)
      }
    }
  }
}
