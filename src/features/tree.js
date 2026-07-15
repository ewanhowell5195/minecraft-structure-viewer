// ported from the decompiled 26.3 placers; randomness is distribution-faithful, not bit-exact
import { nextInt, sampleInt, sampleState } from "./providers.js"
import { DIR, HORIZ as HORIZ_NAMES, OPP } from "../transforms.js"

const LEAVES = /(_leaves|azalea)$/
const HORIZ = HORIZ_NAMES.map(n => [DIR[n][0], DIR[n][2], n, OPP[n]])
const randDir = rand => HORIZ[nextInt(rand, 4)]

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(rand, i + 1); const t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  return arr
}

// vanilla shuffles all six directions, then drops the vertical ones
const shuffledHorizDirs = rand => shuffle([null, null, HORIZ[0], HORIZ[2], HORIZ[3], HORIZ[1]], rand).filter(Boolean)

function isLeaves(cell) { return !!cell && LEAVES.test(cell.Name.replace("minecraft:", "")) }

export function makeTreeCtx(world, config, rand) {
  const logs = [], leaves = [], leafSet = new Set()
  const validTreePos = (x, y, z) => y >= 0 && (!world.get(x, y, z) || isLeaves(world.get(x, y, z)))
  const ctx = {
    world, rand, config, logs, leaves,
    validTreePos,
    placeLog(x, y, z, axisOverride) {
      if (!validTreePos(x, y, z)) return false
      let state = sampleState(config.trunk_provider, rand)
      if (axisOverride && state.Properties && "axis" in state.Properties) state = { Name: state.Name, Properties: { ...state.Properties, axis: axisOverride } }
      world.set(x, y, z, state)
      logs.push([x, y, z])
      return true
    },
    placeLogIfFree(x, y, z) {
      const cell = world.get(x, y, z)
      if (cell && !isLeaves(cell)) return false
      return ctx.placeLog(x, y, z)
    },
    placeBelowTrunk(x, y, z) {
      const state = sampleState(config.below_trunk_provider, rand)
      if (state) world.set(x, y, z, state)
    },
    tryPlaceLeaf(x, y, z) {
      if (!validTreePos(x, y, z)) return false
      const state = sampleState(config.foliage_provider, rand)
      if (!state) return false
      world.set(x, y, z, state)
      leaves.push([x, y, z])
      leafSet.add(x + "," + y + "," + z)
      return true
    },
    leafAt: (x, y, z) => leafSet.has(x + "," + y + "," + z),
    setState(x, y, z, state) { world.set(x, y, z, state) }
  }
  return ctx
}

function offsetTreeCtx(ctx, dy) {
  return {
    ...ctx,
    validTreePos: (x, y, z) => ctx.validTreePos(x, y + dy, z),
    placeLog: (x, y, z, axis) => ctx.placeLog(x, y + dy, z, axis),
    placeLogIfFree: (x, y, z) => ctx.placeLogIfFree(x, y + dy, z),
    placeBelowTrunk: (x, y, z) => ctx.placeBelowTrunk(x, y + dy, z),
    tryPlaceLeaf: (x, y, z) => ctx.tryPlaceLeaf(x, y + dy, z),
    leafAt: (x, y, z) => ctx.leafAt(x, y + dy, z),
    setState: (x, y, z, state) => ctx.setState(x, y + dy, z, state)
  }
}

const attach = (x, y, z, radiusOffset, opts = {}) => ({
  x, y, z, radiusOffset,
  heightOffset: opts.heightOffset ?? 0,
  sizeX: opts.double ? 2 : 1,
  sizeZ: opts.double ? 2 : 1
})
const isDouble = a => a.sizeX === 2 && a.sizeZ === 2

// ---- trunk placers: each returns the foliage attachment list

const TRUNKS = {
  straight_trunk_placer(ctx, p, height, rand) {
    ctx.placeBelowTrunk(0, -1, 0)
    for (let y = 0; y < height; y++) ctx.placeLog(0, y, 0)
    return [attach(0, height, 0, 0)]
  },

  forking_trunk_placer(ctx, p, height, rand) {
    ctx.placeBelowTrunk(0, -1, 0)
    const out = []
    const lean = randDir(rand)
    const leanHeight = height - nextInt(rand, 4) - 1
    let leanSteps = 3 - nextInt(rand, 3)
    let tx = 0, tz = 0, ey = null
    for (let yo = 0; yo < height; yo++) {
      if (yo >= leanHeight && leanSteps > 0) { tx += lean[0]; tz += lean[1]; leanSteps-- }
      if (ctx.placeLog(tx, yo, tz)) ey = yo + 1
    }
    if (ey !== null) out.push(attach(tx, ey, tz, 1))
    tx = 0; tz = 0
    const branch = randDir(rand)
    if (branch !== lean) {
      const branchStart = leanHeight - nextInt(rand, 2) - 1
      let steps = 1 + nextInt(rand, 3)
      ey = null
      for (let yo = branchStart; yo < height && steps > 0; steps--) {
        if (yo >= 1) {
          tx += branch[0]; tz += branch[1]
          if (ctx.placeLog(tx, yo, tz)) ey = yo + 1
        }
        yo++
      }
      if (ey !== null) out.push(attach(tx, ey, tz, 0))
    }
    return out
  },

  fancy_trunk_placer(ctx, p, treeHeight, rand) {
    const height = treeHeight + 2
    const trunkHeight = Math.floor(height * 0.618)
    ctx.placeBelowTrunk(0, -1, 0)
    const clustersPerY = Math.min(1, Math.floor(1.382 + Math.pow(height / 13, 2)))
    const trunkTop = trunkHeight
    const coords = [{ x: 0, y: height - 5, z: 0, base: trunkTop }]
    const shape = y => {
      if (y < height * 0.3) return -1
      const radius = height / 2
      const adj = radius - y
      if (adj === 0) return radius * 0.5
      if (Math.abs(adj) >= radius) return 0
      return Math.sqrt(radius * radius - adj * adj) * 0.5
    }
    for (let relY = height - 5; relY >= 0; relY--) {
      const s = shape(relY)
      if (s < 0) continue
      for (let i = 0; i < clustersPerY; i++) {
        const radius = s * (rand() + 0.328)
        const angle = rand() * 2 * Math.PI
        const cx = Math.floor(radius * Math.sin(angle) + 0.5)
        const cz = Math.floor(radius * Math.cos(angle) + 0.5)
        const branchY = relY - 1 - Math.sqrt(cx * cx + cz * cz) * 0.381
        const base = Math.min(trunkTop, Math.floor(branchY))
        coords.push({ x: cx, y: relY - 1, z: cz, base })
      }
    }
    const limb = (x0, y0, z0, x1, y1, z1) => {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0))
      if (!steps) { ctx.placeLog(x0, y0, z0); return }
      const dx = (x1 - x0) / steps, dy = (y1 - y0) / steps, dz = (z1 - z0) / steps
      for (let i = 0; i <= steps; i++) {
        const px = x0 + Math.floor(0.5 + i * dx), py = y0 + Math.floor(0.5 + i * dy), pz = z0 + Math.floor(0.5 + i * dz)
        const xd = Math.abs(px - x0), zd = Math.abs(pz - z0)
        const axis = Math.max(xd, zd) > 0 ? (xd >= zd ? "x" : "z") : "y"
        ctx.placeLog(px, py, pz, axis)
      }
    }
    limb(0, 0, 0, 0, trunkHeight, 0)
    const trim = base => base >= height * 0.2
    for (const c of coords) {
      if (trim(c.base) && !(c.x === 0 && c.z === 0 && c.base === c.y)) limb(0, c.base, 0, c.x, c.y, c.z)
    }
    return coords.filter(c => trim(c.base)).map(c => attach(c.x, c.y, c.z, 0))
  },

  giant_trunk_placer(ctx, p, height, rand) {
    for (const [bx, bz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) ctx.placeBelowTrunk(bx, -1, bz)
    for (let y = 0; y < height; y++) {
      ctx.placeLogIfFree(0, y, 0)
      if (y < height - 1) {
        ctx.placeLogIfFree(1, y, 0)
        ctx.placeLogIfFree(1, y, 1)
        ctx.placeLogIfFree(0, y, 1)
      }
    }
    return [attach(0, height, 0, 0, { double: true })]
  },

  mega_jungle_trunk_placer(ctx, p, height, rand) {
    const out = TRUNKS.giant_trunk_placer(ctx, p, height, rand)
    for (let branchHeight = height - 2 - nextInt(rand, 4); branchHeight > height / 2; branchHeight -= 2 + nextInt(rand, 4)) {
      const angle = rand() * 2 * Math.PI
      let bx = 0, bz = 0
      for (let b = 0; b < 5; b++) {
        bx = Math.trunc(1.5 + Math.cos(angle) * b)
        bz = Math.trunc(1.5 + Math.sin(angle) * b)
        ctx.placeLog(bx, branchHeight - 3 + Math.floor(b / 2), bz)
      }
      out.push(attach(bx, branchHeight, bz, -2))
    }
    return out
  },

  dark_oak_trunk_placer(ctx, p, height, rand) {
    const out = []
    for (const [bx, bz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) ctx.placeBelowTrunk(bx, -1, bz)
    const lean = randDir(rand)
    const leanHeight = height - nextInt(rand, 4)
    let leanSteps = 2 - nextInt(rand, 3)
    let tx = 0, tz = 0
    const ey = height - 1
    for (let dy = 0; dy < height; dy++) {
      if (dy >= leanHeight && leanSteps > 0) { tx += lean[0]; tz += lean[1]; leanSteps-- }
      if (ctx.validTreePos(tx, dy, tz)) {
        ctx.placeLog(tx, dy, tz)
        ctx.placeLog(tx + 1, dy, tz)
        ctx.placeLog(tx, dy, tz + 1)
        ctx.placeLog(tx + 1, dy, tz + 1)
      }
    }
    out.push(attach(tx, ey, tz, 0, { double: true }))
    for (let ox = -1; ox <= 2; ox++) for (let oz = -1; oz <= 2; oz++) {
      if (ox >= 0 && ox <= 1 && oz >= 0 && oz <= 1) continue
      if (nextInt(rand, 3) > 0) continue
      const length = nextInt(rand, 3) + 2
      for (let by = 0; by < length; by++) ctx.placeLog(ox, ey - by - 1, oz)
      out.push(attach(ox, ey, oz, 0))
    }
    return out
  },

  bending_trunk_placer(ctx, p, height, rand) {
    const dir = randDir(rand)
    const logHeight = height - 1
    let x = 0, y = 0, z = 0
    ctx.placeBelowTrunk(0, -1, 0)
    const out = []
    for (let i = 0; i <= logHeight; i++) {
      if (i + 1 >= logHeight + nextInt(rand, 2)) { x += dir[0]; z += dir[1] }
      if (ctx.validTreePos(x, y, z)) ctx.placeLog(x, y, z)
      if (i >= (p.min_height_for_leaves ?? 1)) out.push(attach(x, y, z, 0))
      y++
    }
    const bendLength = sampleInt(p.bend_length, rand)
    for (let i = 0; i <= bendLength; i++) {
      if (ctx.validTreePos(x, y, z)) ctx.placeLog(x, y, z)
      out.push(attach(x, y, z, 0))
      x += dir[0]; z += dir[1]
    }
    return out
  },

  upwards_branching_trunk_placer(ctx, p, height, rand) {
    const out = []
    for (let yo = 0; yo < height; yo++) {
      if (ctx.placeLog(0, yo, 0) && yo < height - 1 && rand() < p.place_branch_per_log_probability) {
        const dir = randDir(rand)
        const branchLen = sampleInt(p.extra_branch_length, rand)
        const branchStart = Math.max(0, branchLen - sampleInt(p.extra_branch_length, rand) - 1)
        let steps = sampleInt(p.extra_branch_steps, rand)
        let bx = 0, bz = 0, topY = yo + branchStart
        let i = branchStart
        while (i < height && steps > 0) {
          if (i >= 1) {
            const py = yo + i
            bx += dir[0]; bz += dir[1]
            topY = py
            if (ctx.placeLog(bx, py, bz)) topY++
            out.push(attach(bx, py, bz, 0))
          }
          i++; steps--
        }
        if (topY - yo > 1) {
          out.push(attach(bx, topY, bz, 0))
          out.push(attach(bx, topY - 2, bz, 0))
        }
      }
      if (yo === height - 1) out.push(attach(0, yo + 1, 0, 0))
    }
    return out
  },

  cherry_trunk_placer(ctx, p, height, rand) {
    ctx.placeBelowTrunk(0, -1, 0)
    const startProv = p.branch_start_offset_from_top
    const sampleStart = uni => uni.min_inclusive + nextInt(rand, uni.max_inclusive - uni.min_inclusive + 1)
    const first = Math.max(0, height - 1 + sampleStart(startProv))
    let second = Math.max(0, height - 1 + sampleStart({ min_inclusive: startProv.min_inclusive, max_inclusive: startProv.max_inclusive - 1 }))
    if (second >= first) second++
    const branchCount = sampleInt(p.branch_count, rand)
    const hasMiddle = branchCount === 3
    const hasBoth = branchCount >= 2
    const trunkHeight = hasMiddle ? height : hasBoth ? Math.max(first, second) + 1 : first + 1
    for (let y = 0; y < trunkHeight; y++) ctx.placeLog(0, y, 0)
    const out = []
    if (hasMiddle) out.push(attach(0, trunkHeight, 0, 0))
    const dir = randDir(rand)
    const branch = (d, offset) => {
      let lx = 0, ly = offset, lz = 0
      const endOffset = height - 1 + sampleInt(p.branch_end_offset_from_top, rand)
      const extend = offset < trunkHeight - 1 || endOffset < offset
      const distance = sampleInt(p.branch_horizontal_length, rand) + (extend ? 1 : 0)
      const ex = d[0] * distance, ez = d[1] * distance, eyy = endOffset
      const axis = d[0] !== 0 ? "x" : "z"
      for (let i = 0; i < (extend ? 2 : 1); i++) {
        lx += d[0]; lz += d[1]
        ctx.placeLog(lx, ly, lz, axis)
      }
      const vdir = eyy > ly ? 1 : -1
      while (true) {
        const dist = Math.abs(ex - lx) + Math.abs(ez - lz) + Math.abs(eyy - ly)
        if (dist === 0) return attach(ex, eyy + 1, ez, 0)
        const vertChance = Math.abs(eyy - ly) / dist
        const vertical = rand() < vertChance
        if (vertical) ly += vdir
        else { lx += d[0]; lz += d[1] }
        ctx.placeLog(lx, ly, lz, vertical ? "y" : axis)
      }
    }
    out.push(branch(dir, first))
    if (hasBoth) out.push(branch([-dir[0], -dir[1]], second))
    return out
  },

  poplar_trunk_placer(ctx, p, height, rand) {
    ctx.placeBelowTrunk(0, -1, 0)
    const upToBranches = height - sampleInt(p.trunk_height_above_branches, rand)
    for (let y = 0; y < height; y++) {
      ctx.placeLog(0, y, 0)
      const dirs = shuffledHorizDirs(rand)
      if (upToBranches - 1 === y) {
        const branches = sampleInt(p.branch_amount, rand)
        for (let i = 0; i < branches; i++) {
          const d = dirs[i]
          ctx.placeLog(d[0], y, d[1], d[0] !== 0 ? "x" : "z")
        }
      }
    }
    return [attach(0, upToBranches, 0, 0)]
  }
}

// ---- foliage placers

function leavesRow(ctx, fp, a, radius, yo, skip) {
  const off = isDouble(a) ? 1 : 0
  for (let dx = -radius; dx <= radius + off; dx++) {
    for (let dz = -radius; dz <= radius + off; dz++) {
      const mx = off ? Math.min(Math.abs(dx), Math.abs(dx - 1)) : Math.abs(dx)
      const mz = off ? Math.min(Math.abs(dz), Math.abs(dz - 1)) : Math.abs(dz)
      if (skip(mx, yo, mz, radius, dx, dz)) continue
      ctx.tryPlaceLeaf(a.x + dx, a.y + yo, a.z + dz)
    }
  }
}

const cornerSkip = rand => (dx, y, dz, r) => dx === r && dz === r && (nextInt(rand, 2) === 0 || y === 0)
const spruceSkip = () => (dx, y, dz, r) => dx === r && dz === r && r > 0
const circleSkip = () => (dx, y, dz, r) => dx + dz >= 7 || dx * dx + dz * dz > r * r
const fancySkip = () => (dx, y, dz, r) => (dx + 0.5) * (dx + 0.5) + (dz + 0.5) * (dz + 0.5) > r * r

const FOLIAGE = {
  blob_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    const h = foliageHeight + a.heightOffset
    for (let yo = offset; yo >= offset - h; yo--) {
      leavesRow(ctx, fp, a, Math.max(radius + a.radiusOffset - 1 - Math.trunc(yo / 2), 0), yo, cornerSkip(rand))
    }
  },
  bush_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    const h = foliageHeight + a.heightOffset
    for (let yo = offset; yo >= offset - h; yo--) {
      leavesRow(ctx, fp, a, radius + a.radiusOffset - 1 - yo, yo, (dx, y, dz, r) => dx === r && dz === r && nextInt(rand, 2) === 0)
    }
  },
  fancy_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    for (let yo = offset; yo >= offset - foliageHeight; yo--) {
      leavesRow(ctx, fp, a, radius + (yo !== offset && yo !== offset - foliageHeight ? 1 : 0), yo, fancySkip())
    }
  },
  spruce_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    let current = nextInt(rand, 2), max = 1, min = 0
    const h = foliageHeight + a.heightOffset
    for (let yo = offset; yo >= -h; yo--) {
      leavesRow(ctx, fp, a, current, yo, spruceSkip())
      if (current >= max) {
        current = min
        min = 1
        max = Math.min(max + 1, radius + a.radiusOffset)
      } else current++
    }
  },
  pine_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    let current = 0
    const h = foliageHeight + a.heightOffset
    for (let yo = offset; yo >= offset - h; yo--) {
      leavesRow(ctx, fp, a, current, yo, spruceSkip())
      if (current >= 1 && yo === offset - h + 1) current--
      else if (current < radius + a.radiusOffset) current++
    }
  },
  acacia_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    const h = foliageHeight + a.heightOffset
    const skip = (dx, y, dz, r) => y === 0 ? (dx > 1 || dz > 1) && dx !== 0 && dz !== 0 : dx === r && dz === r && r > 0
    const at = { ...a, y: a.y + offset }
    leavesRow(ctx, fp, at, radius + a.radiusOffset, -1 - h, skip)
    leavesRow(ctx, fp, at, radius - 1, -h, skip)
    leavesRow(ctx, fp, at, radius + a.radiusOffset - 1, 0, skip)
  },
  mega_pine_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    let prev = 0
    const h = foliageHeight + a.heightOffset
    for (let yy = a.y - h + offset; yy <= a.y + offset; yy++) {
      const yo = a.y - yy
      const smooth = radius + a.radiusOffset + Math.floor(yo / h * 3.5)
      const r = yo > 0 && smooth === prev && (yy & 1) === 0 ? smooth + 1 : smooth
      leavesRow(ctx, fp, { ...a, y: yy }, r, 0, circleSkip())
      prev = smooth
    }
  },
  jungle_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    return FOLIAGE.mega_jungle_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand)
  },
  mega_jungle_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    const h = (isDouble(a) ? foliageHeight : 1 + nextInt(rand, 2)) + a.heightOffset
    for (let yo = offset; yo >= offset - h; yo--) {
      leavesRow(ctx, fp, a, radius + a.radiusOffset + 1 - yo, yo, circleSkip())
    }
  },
  dark_oak_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    const at = { ...a, y: a.y + offset }
    const dbl = isDouble(a)
    const skip = (dx, y, dz, r, sx, sz) => {
      if (y === 0 && dbl && (sx === -r || sx >= r || sz === -r || sz >= r)) return true
      if (y === -1 && !dbl) return dx === r && dz === r
      return y === 1 ? dx + dz > r * 2 - 2 : false
    }
    if (dbl) {
      leavesRow(ctx, fp, at, radius + 2, -1, skip)
      leavesRow(ctx, fp, at, radius + 3, 0, skip)
      leavesRow(ctx, fp, at, radius + 2, 1, skip)
      if (rand() < 0.5) leavesRow(ctx, fp, at, radius, 2, skip)
    } else {
      leavesRow(ctx, fp, at, radius + 2, -1, skip)
      leavesRow(ctx, fp, at, radius + 1, 0, skip)
    }
  },
  random_spread_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    for (let i = 0; i < fp.leaf_placement_attempts; i++) {
      ctx.tryPlaceLeaf(
        a.x + nextInt(rand, radius) - nextInt(rand, radius),
        a.y + nextInt(rand, foliageHeight) - nextInt(rand, foliageHeight),
        a.z + nextInt(rand, radius) - nextInt(rand, radius)
      )
    }
  },
  cherry_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    const at = { ...a, y: a.y + offset }
    const r = radius + a.radiusOffset - 1
    const h = foliageHeight + a.heightOffset
    const skip = (dx, y, dz, cr) => {
      if (y === -1 && (dx === cr || dz === cr) && rand() < fp.wide_bottom_layer_hole_chance) return true
      const corner = dx === cr && dz === cr
      if (cr > 2) return corner || dx + dz > cr * 2 - 2 && rand() < fp.corner_hole_chance
      return corner && rand() < fp.corner_hole_chance
    }
    leavesRow(ctx, fp, at, r - 2, h - 3, skip)
    leavesRow(ctx, fp, at, r - 1, h - 4, skip)
    for (let y = h - 5; y >= 0; y--) leavesRow(ctx, fp, at, r, y, skip)
    hangingRow(ctx, fp, at, r, -1, skip, rand)
    hangingRow(ctx, fp, at, r - 1, -2, skip, rand)
  },
  poplar_foliage_placer(ctx, fp, a, foliageHeight, radius, offset, rand) {
    const at = { ...a, y: a.y + offset }
    const r = radius + a.radiusOffset - 1
    const flip = rand() < 0.5
    const h = foliageHeight + a.heightOffset
    const partialRow = y => y === h - 1 || y === h - 2
    const cornerCut = (dx, dz, cr, partial) => {
      const small = flip ? (dx > 0 && dz > 0) || (dz < 0 && dx < 0) : (dx > 0 && dz < 0) || (dz > 0 && dx < 0)
      return small ? cr - 1 : partial ? cr + 1 : cr
    }
    const inRhombus = (cr, ax, az, cut, extra) => ax + az <= cr * 2 - (cut + extra)
    const skip = (mx, y, mz, cr, dx, dz) => {
      const partial = partialRow(y)
      const cut = cornerCut(dx, dz, cr, partial)
      const ax = Math.abs(dx), az = Math.abs(dz)
      if (partial && (ax === cr || az === cr)) return true
      const extra = rand() <= (fp.side_hole_chance ?? 0) ? 1 : 0
      return !inRhombus(cr, ax, az, cut, extra)
    }
    leavesRow(ctx, fp, at, r - 2, h - 1, skip)
    leavesRow(ctx, fp, at, r - 1, h - 2, skip)
    leavesRow(ctx, fp, at, r - 1, h - 3, skip)
    for (let y = h - 4; y >= 1; y--) leavesRow(ctx, fp, at, r, y, skip)
    const off = isDouble(at) ? 1 : 0
    for (let dx = -r; dx <= r + off; dx++) {
      for (let dz = -r; dz <= r + off; dz++) {
        const ax = Math.abs(dx), az = Math.abs(dz)
        if (!inRhombus(r, ax, az, cornerCut(dx, dz, r, partialRow(h - 4)), 2)) continue
        if (!(az === 0 && r - ax >= 4 || ax === 0 && r - az >= 4)) continue
        const px = at.x + dx, py = at.y + h - 4, pz = at.z + dz
        if (!ctx.leafAt(px, py, pz)) continue
        let state = sampleState(ctx.config.trunk_provider, rand)
        if (state.Properties && "axis" in state.Properties) state = { Name: state.Name, Properties: { ...state.Properties, axis: az === 0 ? "x" : "z" } }
        ctx.setState(px, py, pz, state)
      }
    }
    leavesRow(ctx, fp, at, r - 1, 0, skip)
    leavesRow(ctx, fp, at, Math.min(Math.max(r - 2, 1), 2), -1, skip)
  }
}

function hangingRow(ctx, fp, a, radius, yo, skip, rand) {
  leavesRow(ctx, fp, a, radius, yo, skip)
  const off = isDouble(a) ? 1 : 0
  for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const clockX = -dz, clockZ = dx
    const edge = (clockX > 0 || clockZ > 0) ? radius + off : radius
    for (let along = -radius; along < radius + off; along++) {
      const px = a.x + clockX * edge + dx * along
      const pz = a.z + clockZ * edge + dz * along
      const py = a.y + yo - 1
      if (Math.abs(px - a.x) + Math.abs(pz - a.z) + Math.abs(py + 1 - a.y) >= 7) continue
      if (!ctx.leafAt(px, py + 1, pz)) continue
      if (rand() > fp.hanging_leaves_chance) continue
      if (ctx.tryPlaceLeaf(px, py, pz)
        && Math.abs(px - a.x) + Math.abs(pz - a.z) + Math.abs(py - a.y) < 7
        && rand() <= fp.hanging_leaves_extension_chance) {
        ctx.tryPlaceLeaf(px, py - 1, pz)
      }
    }
  }
}

function foliageHeightOf(fp, rand, treeHeight) {
  switch ((fp.type ?? "").replace("minecraft:", "")) {
    case "blob_foliage_placer": case "bush_foliage_placer": case "fancy_foliage_placer": return fp.height ?? 3
    case "spruce_foliage_placer": return Math.max(4, treeHeight - sampleInt(fp.trunk_height, rand))
    case "pine_foliage_placer": case "cherry_foliage_placer": case "poplar_foliage_placer": return sampleInt(fp.height, rand)
    case "mega_pine_foliage_placer": return sampleInt(fp.crown_height, rand)
    case "jungle_foliage_placer": case "mega_jungle_foliage_placer": return fp.height
    case "random_spread_foliage_placer": return sampleInt(fp.foliage_height, rand)
    case "acacia_foliage_placer": return 0
    case "dark_oak_foliage_placer": return 4
  }
  return 3
}

// ---- decorators

function decorate(ctx, decorators, rand, opts) {
  const logs = [...ctx.logs].sort((p, q) => p[1] - q[1])
  const leaves = [...ctx.leaves].sort((p, q) => p[1] - q[1])
  const world = ctx.world
  const isAir = (x, y, z) => y >= 0 && !world.get(x, y, z)
  const vine = (x, y, z, dir) => {
    if (!world.get(x, y, z) && y >= 0) world.set(x, y, z, { Name: "minecraft:vine", Properties: { [dir]: "true" } })
  }
  for (const d of decorators ?? []) {
    switch ((d.type ?? "").replace("minecraft:", "")) {
      case "trunk_vine":
        for (const [x, y, z] of logs) {
          if (nextInt(rand, 3) > 0) vine(x - 1, y, z, "east")
          if (nextInt(rand, 3) > 0) vine(x + 1, y, z, "west")
          if (nextInt(rand, 3) > 0) vine(x, y, z - 1, "south")
          if (nextInt(rand, 3) > 0) vine(x, y, z + 1, "north")
        }
        break
      case "leave_vine": {
        const hang = (x, y, z, dir) => {
          vine(x, y, z, dir)
          for (let i = 4, py = y - 1; i > 0 && !world.get(x, py, z) && py >= 0; i--, py--) vine(x, py, z, dir)
        }
        for (const [x, y, z] of leaves) {
          if (rand() < d.probability && !world.get(x - 1, y, z)) hang(x - 1, y, z, "east")
          if (rand() < d.probability && !world.get(x + 1, y, z)) hang(x + 1, y, z, "west")
          if (rand() < d.probability && !world.get(x, y, z - 1)) hang(x, y, z - 1, "south")
          if (rand() < d.probability && !world.get(x, y, z + 1)) hang(x, y, z + 1, "north")
        }
        break
      }
      case "cocoa": {
        if (rand() >= d.probability || !logs.length) break
        const baseY = logs[0][1]
        for (const [x, y, z] of logs) {
          if (y - baseY > 2) continue
          for (const [dx, dz, facing] of HORIZ) {
            if (rand() > 0.25) continue
            const px = x - dx, pz = z - dz
            if (!world.get(px, y, pz)) {
              world.set(px, y, pz, { Name: "minecraft:cocoa", Properties: { age: String(nextInt(rand, 3)), facing } })
            }
          }
        }
        break
      }
      case "beehive": {
        if (rand() >= d.probability || !logs.length) break
        const hiveY = leaves.length
          ? Math.max(leaves[0][1] - 1, logs[0][1] + 1)
          : Math.min(logs[0][1] + 1 + nextInt(rand, 3), logs[logs.length - 1][1])
        const spots = []
        for (const [x, y, z] of logs) {
          if (y !== hiveY) continue
          for (const [dx, dz] of [[0, 1], [-1, 0], [1, 0]]) spots.push([x + dx, y, z + dz])
        }
        shuffle(spots, rand)
        for (const [x, y, z] of spots) {
          if (world.get(x, y, z) || world.get(x, y, z + 1)) continue
          world.set(x, y, z, { Name: "minecraft:bee_nest", Properties: { facing: "south", honey_level: "0" } })
          break
        }
        break
      }
      // the viewer's grid is the ground: the plane just below the trunk base counts as solid
      case "place_on_ground": {
        if (!logs.length) break
        const baseY = logs[0][1]
        const base = logs.filter(l => l[1] === baseY)
        let minX = base[0][0], maxX = base[0][0], minZ = base[0][2], maxZ = base[0][2]
        for (const [x, , z] of base) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (z < minZ) minZ = z
          if (z > maxZ) maxZ = z
        }
        const r = d.radius ?? 2, h = d.height ?? 1
        const topY = Math.max(logs[logs.length - 1][1], leaves.length ? leaves[leaves.length - 1][1] : 0)
        const solidAt = (x, y, z) => {
          const c = world.get(x, y, z)
          if (c) return /_log|_wood|dirt|podzol|_nest/.test(c.Name)
          return y === baseY - 1
        }
        for (let i = 0; i < (d.tries ?? 128); i++) {
          const x = minX - r + nextInt(rand, maxX - minX + 2 * r + 1)
          const y = baseY - h + nextInt(rand, 2 * h + 1)
          const z = minZ - r + nextInt(rand, maxZ - minZ + 2 * r + 1)
          const above = world.get(x, y + 1, z)
          if ((above && !/vine/.test(above.Name)) || !solidAt(x, y, z)) continue
          // MOTION_BLOCKING_NO_LEAVES: nothing but leaves/vines overhead
          let clear = true
          for (let wy = y + 2; wy <= topY && clear; wy++) {
            const c = world.get(x, wy, z)
            if (c && !/leaves|vine|litter/.test(c.Name)) clear = false
          }
          if (!clear) continue
          const state = sampleState(d.block_state_provider, rand)
          if (state) world.set(x, y + 1, z, state)
        }
        break
      }
      case "creaking_heart": {
        if (rand() >= d.probability || !logs.length) break
        const pool = shuffle([...logs], rand)
        for (const [x, y, z] of pool) {
          let buried = true
          for (const [dx, dy, dz] of Object.values(DIR)) {
            const c = world.get(x + dx, y + dy, z + dz)
            if (!c || !/_log|_wood/.test(c.Name)) { buried = false; break }
          }
          if (!buried) continue
          world.set(x, y, z, { Name: "minecraft:creaking_heart", Properties: { axis: "y", creaking_heart_state: "dormant", natural: "true" } })
          break
        }
        break
      }
      case "attached_to_leaves": {
        const blacklist = new Set()
        const shuffled = shuffle([...leaves], rand)
        for (const [x, y, z] of shuffled) {
          const dirName = d.directions[nextInt(rand, d.directions.length)]
          const [dx, dy, dz] = DIR[dirName]
          const px = x + dx, py = y + dy, pz = z + dz
          if (blacklist.has(px + "," + py + "," + pz) || rand() >= d.probability) continue
          let free = true
          for (let i = 1; i <= d.required_empty_blocks; i++) {
            if (world.get(x + dx * i, y + dy * i, z + dz * i)) { free = false; break }
          }
          if (!free || py < 0) continue
          for (let ex = -d.exclusion_radius_xz; ex <= d.exclusion_radius_xz; ex++)
            for (let ey = -d.exclusion_radius_y; ey <= d.exclusion_radius_y; ey++)
              for (let ez = -d.exclusion_radius_xz; ez <= d.exclusion_radius_xz; ez++)
                blacklist.add((px + ex) + "," + (py + ey) + "," + (pz + ez))
          const state = sampleState(d.block_provider, rand)
          if (state) world.set(px, py, pz, state)
        }
        break
      }
      case "attached_to_logs": {
        for (const [x, y, z] of shuffle([...logs], rand)) {
          const dirName = d.directions[nextInt(rand, d.directions.length)].replace("minecraft:", "")
          const [dx, dy, dz] = DIR[dirName]
          const px = x + dx, py = y + dy, pz = z + dz
          if (rand() <= d.probability && isAir(px, py, pz)) {
            const state = sampleState(d.block_provider, rand)
            if (state) world.set(px, py, pz, state)
          }
        }
        break
      }
      case "shelf_mushroom": {
        if (rand() >= d.probability || !logs.length) break
        const isShelf = (x, y, z) => world.get(x, y, z)?.Name === "minecraft:shelf_mushroom"
        const shelfNextTo = (x, y, z) => HORIZ.some(([hx, hz]) => isShelf(x + hx, y, z + hz))
        const place = (x, y, z, facing) => world.set(x, y, z, { Name: "minecraft:shelf_mushroom", Properties: { age: String(nextInt(rand, 2)), facing } })
        const first = logs[0], last = logs[logs.length - 1]
        if (first[1] === last[1]) {
          const facings = first[0] !== last[0] ? ["north", "south"] : ["east", "west"]
          for (const [x, y, z] of logs) {
            for (const facing of facings) {
              if (rand() > 0.25) continue
              const px = x + DIR[facing][0], pz = z + DIR[facing][2]
              if (!isAir(px, y, pz)) continue
              if (shelfNextTo(px, y, pz) || shelfNextTo(x, y, z)) continue
              place(px, y, pz, facing)
            }
          }
        } else {
          const i = nextInt(rand, 4)
          const facings = [HORIZ_NAMES[i], HORIZ_NAMES[(i + 1) % 4]]
          const baseY = first[1]
          for (const [x, y, z] of logs) {
            if (y - baseY < 1 || y - baseY > 4) continue
            for (const facing of facings) {
              if (rand() > 0.25) continue
              const px = x + DIR[facing][0], pz = z + DIR[facing][2]
              if (!isAir(px, y, pz) || isShelf(px, y - 1, pz)) continue
              place(px, y, pz, facing)
              break
            }
          }
        }
        break
      }
      case "pale_moss": {
        if (!logs.length) break
        const shuffled = shuffle([...logs], rand)
        let origin = shuffled[0]
        for (const p of shuffled) if (p[1] < origin[1]) origin = p
        // vanilla runs the patch at origin.above() and lets its ground scan drop
        // to the soil; our patch grounds at origin-1 directly, so no +1 here
        if (rand() < d.ground_probability) opts?.runFeature?.("minecraft:pale_moss_patch", origin[0], origin[1], origin[2])
        const moss = tip => ({ Name: "minecraft:pale_hanging_moss", Properties: { tip: String(tip) } })
        const hang = (x, y, z) => {
          while (isAir(x, y - 1, z) && !(rand() < 0.5)) {
            world.set(x, y, z, moss(false))
            y--
          }
          world.set(x, y, z, moss(true))
        }
        for (const [x, y, z] of logs) {
          if (rand() < d.trunk_probability && isAir(x, y - 1, z)) hang(x, y - 1, z)
        }
        for (const [x, y, z] of leaves) {
          if (rand() < d.leaves_probability && isAir(x, y - 1, z)) hang(x, y - 1, z)
        }
        break
      }
      // the ground is virtual: podzol lands on the plane just below the trunk base
      case "alter_ground": {
        if (!logs.length) break
        const baseY = logs[0][1]
        const circle = (cx, cz) => {
          for (let xx = -2; xx <= 2; xx++) for (let zz = -2; zz <= 2; zz++) {
            if (Math.abs(xx) === 2 && Math.abs(zz) === 2) continue
            const state = sampleState(d.provider, rand)
            if (state) world.set(cx + xx, baseY - 1, cz + zz, state)
          }
        }
        for (const [x, y, z] of logs) {
          if (y !== baseY) continue
          circle(x - 1, z - 1)
          circle(x + 2, z - 1)
          circle(x - 1, z + 2)
          circle(x + 2, z + 2)
          for (let i = 0; i < 5; i++) {
            const roll = nextInt(rand, 64)
            const xx = roll % 8, zz = Math.trunc(roll / 8)
            if (xx === 0 || xx === 7 || zz === 0 || zz === 7) circle(x - 3 + xx, z - 3 + zz)
          }
        }
        break
      }
    }
  }
}

// ---- root placer: nothing obstructs the walks here except the grid, which
// ends a branch like unplaceable terrain does in game

function placeMangroveRoots(ctx, rp, trunkY, rand) {
  const placement = rp.mangrove_root_placement
  const maxLength = placement.max_root_length
  const maxWidth = placement.max_root_width
  const skew = placement.random_skew_chance
  const roots = [[0, trunkY - 1, 0]]
  for (const [dx, dz] of HORIZ) {
    const walk = []
    const potentials = (x, y, z) => {
      const below = [x, y - 1, z]
      const width = Math.abs(x) + Math.abs(y - trunkY) + Math.abs(z)
      if (width > maxWidth - 3 && width <= maxWidth) return rand() < skew ? [below, [x + dx, y - 1, z + dz]] : [below]
      if (width > maxWidth) return [below]
      if (rand() < skew) return [below]
      return rand() < 0.5 ? [[x + dx, y, z + dz]] : [below]
    }
    const step = (x, y, z, layer) => {
      if (layer === maxLength || walk.length > maxLength) return
      for (const p of potentials(x, y, z)) {
        if (p[1] < 0) continue
        walk.push(p)
        step(p[0], p[1], p[2], layer + 1)
      }
    }
    step(dx, trunkY, dz, 0)
    roots.push(...walk, [dx, trunkY, dz])
  }
  const arp = rp.above_root_placement
  for (const [x, y, z] of roots) {
    ctx.setState(x, y, z, sampleState(rp.root_provider, rand))
    if (arp && rand() < arp.above_root_placement_chance && !ctx.world.get(x, y + 1, z)) {
      ctx.setState(x, y + 1, z, sampleState(arp.above_root_provider, rand))
    }
  }
}

// ---- entry points

export function generateTree(world, config, rand, opts) {
  const ctx = makeTreeCtx(world, config, rand)
  const tp = config.trunk_placer
  const trunkType = (tp.type ?? "").replace("minecraft:", "")
  const place = TRUNKS[trunkType]
  if (!place) throw new Error(`trunk placer ${tp.type} isn't supported yet`)
  const fp = config.foliage_placer
  const foliageType = (fp.type ?? "").replace("minecraft:", "")
  const foliage = FOLIAGE[foliageType]
  if (!foliage) throw new Error(`foliage placer ${fp.type} isn't supported yet`)

  const treeHeight = tp.base_height + nextInt(rand, tp.height_rand_a + 1) + nextInt(rand, tp.height_rand_b + 1)
  const foliageHeight = foliageHeightOf(fp, rand, treeHeight)
  const trunkHeight = treeHeight - foliageHeight
  let radius = sampleInt(fp.radius, rand)
  if (foliageType === "pine_foliage_placer") radius += nextInt(rand, Math.max(trunkHeight + 1, 1))
  let trunkY = 0
  if (config.root_placer) {
    trunkY = sampleInt(config.root_placer.trunk_offset_y, rand)
    placeMangroveRoots(ctx, config.root_placer, trunkY, rand)
  }
  const offset = sampleInt(fp.offset, rand)

  const tctx = trunkY ? offsetTreeCtx(ctx, trunkY) : ctx
  const attachments = place(tctx, tp, treeHeight, rand)
  for (const a of attachments) foliage(tctx, fp, a, foliageHeight, radius, offset, rand)
  decorate(ctx, config.decorators, rand, opts)
}

export function generateFallenTree(world, config, rand, opts) {
  const ctx = makeTreeCtx(world, { trunk_provider: config.trunk_provider }, rand)
  ctx.placeLog(0, 0, 0)
  const stump = [[0, 0, 0]]
  const dir = randDir(rand)
  const logLength = sampleInt(config.log_length, rand) - 2
  const start = 2 + nextInt(rand, 2)
  const logSet = []
  for (let i = 0; i < logLength; i++) {
    const x = dir[0] * (start + i), z = dir[1] * (start + i)
    ctx.placeLog(x, 0, z, dir[0] !== 0 ? "x" : "z")
    logSet.push([x, 0, z])
  }
  const runDecorators = (decs, positions) => {
    const sub = makeTreeCtx(world, { trunk_provider: config.trunk_provider }, rand)
    sub.logs.push(...positions)
    decorate(sub, decs, rand, opts)
  }
  runDecorators(config.stump_decorators, stump)
  runDecorators(config.log_decorators, logSet)
}
