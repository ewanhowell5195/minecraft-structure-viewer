import { readWorldZip, readRegionFile, switchDimension, readChunk, readEntityChunk, chunkYExtent, unzipEntry, parseZipBlob, REAL_AIR } from "minecraft-block-reader"
export { readWorldZip, readRegionFile, switchDimension, readChunk, chunkYExtent, unzipEntry, parseZipBlob }

const PLANTS = new Set(["poppy", "dandelion", "oxeye_daisy", "azure_bluet", "cornflower", "allium",
  "lilac", "peony", "sunflower", "wither_rose", "wheat", "beetroots", "carrots", "potatoes",
  "sugar_cane", "cactus", "vine", "lily_pad"])
export const DYES = ["white", "light_gray", "gray", "black", "brown", "red", "orange", "yellow",
  "lime", "green", "cyan", "light_blue", "blue", "purple", "magenta", "pink"]
const DYE_CODE = new Map(DYES.map((d, i) => [d, 17 + i]))
const DYE_PREFIX = new RegExp("^(" + [...DYES].sort((a, b) => b.length - a.length).join("|") + ")_")
function surfaceCode(name) {
  const n = name.replace(/^minecraft:/, "")
  if (n === "water" || n === "kelp" || n === "kelp_plant" || n.endsWith("seagrass")) return 2
  if (n === "grass_block" || n.startsWith("moss_")) return 3
  if (n === "lava" || n === "magma_block") return 11
  if (n === "snow" || n === "snow_block" || n === "powder_snow") return 8
  if (n === "bedrock") return 15
  if (n === "netherrack") return 13
  if (n.startsWith("end_stone")) return 14
  if (n.startsWith("nether_wart")) return 33
  if (n === "warped_wart_block") return 34
  if (n === "soul_sand" || n === "soul_soil") return 35
  if (n.endsWith("basalt")) return 36
  if (n.includes("blackstone")) return 37
  if (n.includes("nether_brick")) return 38
  if (n.endsWith("gravel")) return 16
  if (n.endsWith("ice")) return 9
  if (n.includes("red_sand")) return 56
  if (n.endsWith("sand") || n.endsWith("sandstone")) return 5
  if (n.includes("copper") && !n.endsWith("_ore")) {
    if (n.includes("oxidized")) return 67
    if (n.includes("weathered")) return 66
    if (n.includes("exposed")) return 65
    return 64
  }
  if (n === "glass" || n === "glass_pane") return 61
  if (n === "bricks" || n.startsWith("brick_")) return 62
  if (n.includes("quartz") && !n.endsWith("_ore")) return 63
  if (n.endsWith("_log") || n.endsWith("_wood") || n.endsWith("_stem") || n.endsWith("_hyphae") || n.endsWith("_planks") || n.startsWith("bamboo") ||
    n.endsWith("_fence") || n.endsWith("_fence_gate") || n.endsWith("_door") || n.endsWith("_trapdoor")) return 6
  if (n === "pale_oak_leaves" || (n.startsWith("pale_") && n.includes("moss"))) return 68
  if (n === "cherry_leaves") return 57
  if (n === "yellow_poplar_leaves") return 58
  if (n === "orange_poplar_leaves") return 59
  if (n === "red_poplar_leaves") return 60
  if (n.endsWith("_leaves")) return 7
  if (n === "dirt" || n.endsWith("_dirt") || n === "dirt_path" || n === "podzol" || n === "mud" || n === "mycelium" || n === "farmland") return 10
  if (n.endsWith("grass") || n.endsWith("fern") || n.endsWith("bush") || n.endsWith("sapling") || n.endsWith("_tulip") ||
    n.endsWith("_orchid") || n.endsWith("_petals") || n.endsWith("flower") || n.startsWith("sweet_berry") || PLANTS.has(n)) return 12
  if (n === "terracotta") return 55
  const dye = n.match(DYE_PREFIX)
  if (dye) {
    if (n.endsWith("_terracotta") && !n.includes("glazed")) return 39 + DYES.indexOf(dye[1])
    return DYE_CODE.get(dye[1])
  }
  return 4
}

function manmade(name) {
  const n = name.replace(/^minecraft:/, "")
  return n.endsWith("_planks") || n.endsWith("_slab") || n.endsWith("_stairs") || n.endsWith("_wall") ||
    n.endsWith("_fence") || n.endsWith("_fence_gate") || n.endsWith("bricks") || n.endsWith("_concrete") ||
    n.endsWith("_log") || n.endsWith("_wood") ||
    n.endsWith("glass") || n.endsWith("_pane") ||
    n.endsWith("_door") || n.endsWith("_trapdoor") ||
    n.startsWith("polished_") || n.startsWith("smooth_") || n.startsWith("chiseled_") || n.startsWith("cut_") ||
    n === "bricks" || (n.includes("quartz") && !n.endsWith("_ore")) ||
    DYE_PREFIX.test(n)
}

export async function chunkSurface(world, chunk, yMin = -Infinity, yMax = Infinity) {
  const nbt = await readChunk(world, chunk)
  const sections = (nbt.sections ?? [])
    .filter(s => s.block_states?.palette && s.Y * 16 <= yMax && s.Y * 16 + 15 >= yMin)
    .sort((a, b) => b.Y - a.Y)
  const cols = new Uint8Array(256)
  const colW = new Uint8Array(256)
  let remaining = 256
  for (const s of sections) {
    if (!remaining) break
    const yTop = Math.min(15, Math.floor(yMax) - s.Y * 16)
    const yBot = Math.max(0, Math.ceil(yMin) - s.Y * 16)
    const pal = s.block_states.palette
    const airMask = pal.map(e => REAL_AIR.test(e.id))
    if (!airMask.includes(false)) continue
    const codes = pal.map(e => surfaceCode(e.id))
    const wts = pal.map(e => manmade(e.id) ? 3 : 1)
    // readNBT already hands longs over as [lo, hi] uint32 pairs; only
    // unresolved columns get probed
    let bits = 0, vpl = 0, mask = 0, u32 = null
    if (pal.length > 1) {
      bits = Math.max(4, 32 - Math.clz32(pal.length - 1))
      vpl = Math.floor(64 / bits)
      mask = (1 << bits) - 1
      u32 = s.block_states.data ?? []
    }
    for (let col = 0; col < 256; col++) {
      if (cols[col]) continue
      for (let y = yTop; y >= yBot; y--) {
        let pi = 0
        if (u32) {
          const i = (y << 8) | col
          const li = (i / vpl) | 0
          const bit = (i - li * vpl) * bits
          pi = bit + bits <= 32 ? (u32[li * 2] >>> bit) & mask
            : bit >= 32 ? (u32[li * 2 + 1] >>> (bit - 32)) & mask
            : ((u32[li * 2] >>> bit) | (u32[li * 2 + 1] << (32 - bit))) & mask
        }
        if (airMask[pi]) continue
        cols[col] = codes[pi]
        colW[col] = wts[pi]
        remaining--
        break
      }
    }
  }
  if (remaining === 256) return null
  const counts = new Uint16Array(64)
  const mode = (arr, wts) => {
    counts.fill(0)
    let best = 0, bn = 0
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i]
      if (!c) continue
      if ((counts[c] += wts[i]) > bn) { bn = counts[c]; best = c }
    }
    return best
  }
  // [0..63] 8x8 sub-cells, [64] whole-chunk mode for the far-out zoom levels
  const sub = new Uint8Array(65)
  const quad = new Uint8Array(4), quadW = new Uint8Array(4)
  for (let sz = 0; sz < 8; sz++) for (let sx = 0; sx < 8; sx++) {
    for (let q = 0; q < 4; q++) {
      const col = (sz * 2 + (q >> 1)) * 16 + sx * 2 + (q & 1)
      quad[q] = cols[col]
      quadW[q] = colW[col]
    }
    sub[sz * 8 + sx] = mode(quad, quadW)
  }
  sub[64] = mode(cols, colW)
  return sub
}

// the modal's JSON dump can't take BigInts or typed arrays
function plain(v) {
  if (typeof v === "bigint") return Number(v)
  if (v instanceof Uint8Array) return Array.from(v)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === "object") {
    const o = {}
    for (const k in v) o[k] = plain(v[k])
    return o
  }
  return v
}

// disconnected chunk islands load like separate structures: each keeps its own
// grid, and the empty space between them collapses to the multi-structure
// spacing while every island keeps its compass direction from the others
function chunkIslands(chunks) {
  const byKey = new Map(chunks.map(c => [c.cx + "," + c.cz, c]))
  const seen = new Set()
  const islands = []
  for (const c of chunks) {
    const k0 = c.cx + "," + c.cz
    if (seen.has(k0)) continue
    seen.add(k0)
    const island = []
    const stack = [c]
    while (stack.length) {
      const cur = stack.pop()
      island.push(cur)
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue
        const k = (cur.cx + dx) + "," + (cur.cz + dz)
        const n = byKey.get(k)
        if (n && !seen.has(k)) { seen.add(k); stack.push(n) }
      }
    }
    islands.push(island)
  }
  return islands
}

// collapse the unoccupied runs of an axis to the packing gap, monotonically so
// relative order (and so direction) between islands is preserved
function axisCollapse(intervals, gap) {
  const merged = []
  for (const iv of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else merged.push([...iv])
  }
  const runs = []
  let shift = 0, prevEnd = null
  for (const [start, end] of merged) {
    if (prevEnd !== null) shift += start - prevEnd - gap
    runs.push([start, shift])
    prevEnd = end
  }
  return x => {
    let out = 0
    for (const [start, sh] of runs) {
      if (x >= start) out = sh
      else break
    }
    return out
  }
}

export async function buildSelection(world, selected, { yMin = -Infinity, yMax = Infinity, budget = Infinity, cap = Infinity } = {}, onProgress) {
  const chunks = world.chunks.filter(c => selected.has(c.cx + "," + c.cz))
  if (!chunks.length) throw new Error("no chunks selected")

  let minCx = Infinity, maxCx = -Infinity, minCz = Infinity, maxCz = -Infinity
  for (const c of chunks) {
    minCx = Math.min(minCx, c.cx); maxCx = Math.max(maxCx, c.cx)
    minCz = Math.min(minCz, c.cz); maxCz = Math.max(maxCz, c.cz)
  }

  const islands = chunkIslands(chunks)
  const chunkShift = new Map()
  let parts = null
  if (islands.length > 1) {
    const GAPB = 9
    const bounds = islands.map(island => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
      for (const c of island) {
        x0 = Math.min(x0, c.cx); x1 = Math.max(x1, c.cx)
        z0 = Math.min(z0, c.cz); z1 = Math.max(z1, c.cz)
      }
      return { x0: x0 * 16, x1: (x1 + 1) * 16, z0: z0 * 16, z1: (z1 + 1) * 16 }
    })
    const shiftX = axisCollapse(bounds.map(b => [b.x0, b.x1]), GAPB)
    const shiftZ = axisCollapse(bounds.map(b => [b.z0, b.z1]), GAPB)
    parts = []
    for (let i = 0; i < islands.length; i++) {
      const b = bounds[i]
      const sx = shiftX(b.x0), sz = shiftZ(b.z0)
      for (const c of islands[i]) chunkShift.set(c.cx + "," + c.cz, [sx, sz])
      parts.push({ b, sx, sz })
    }
  }
  const inRange = s => s.Y * 16 + 15 >= yMin && s.Y * 16 <= yMax
  // two passes re-reading each chunk so only one parsed NBT lives at a time:
  // holding thousands of them was a large slice of the memory that big loads burn
  let minSec = Infinity, maxSec = -Infinity
  let oldSkipped = 0
  let done = 0
  const total = chunks.length * 2
  for (const c of chunks) {
    if (onProgress?.(done++, total) === false) throw new Error("cancelled")
    const nbt = await readChunk(world, c)
    if (!nbt.sections) {
      if (nbt.Level) oldSkipped++
      continue
    }
    for (const s of nbt.sections) {
      const pal = s.block_states?.palette
      if (!inRange(s) || !pal || pal.every(e => REAL_AIR.test(e.id))) continue
      minSec = Math.min(minSec, s.Y)
      maxSec = Math.max(maxSec, s.Y)
    }
  }
  if (minSec === Infinity) {
    if (oldSkipped) {
      const err = new Error("this world's chunks are too old (1.18+ only)")
      err.oldChunks = true
      throw err
    }
    throw new Error("the selected chunks are empty in this y range")
  }
  const x0 = minCx * 16, z0 = minCz * 16
  const y0 = Math.max(minSec * 16, Math.ceil(yMin))
  const yTop = Math.min(maxSec * 16 + 15, Math.floor(yMax))

  const palette = [], palIdx = new Map()
  const stateFor = e => {
    const k = e.id + "|" + JSON.stringify(e.properties ?? null)
    let i = palIdx.get(k)
    if (i === undefined) {
      i = palette.length
      palette.push(e.properties ? { id: e.id, properties: e.properties } : { id: e.id })
      palIdx.set(k, i)
    }
    return i
  }

  const blocks = []
  const entities = []
  const relTop = yTop - y0
  // stop pulling chunks once the block list approaches the memory budget:
  // partial worlds beat dead tabs. Chrome measures the heap live, elsewhere the
  // block count stands in at ~120 bytes each
  const over = () => {
    const mem = performance.memory
    if (mem) return mem.usedJSHeapSize > mem.jsHeapSizeLimit * 0.85
    return blocks.length * 120 > budget
  }
  let loaded = 0, truncated = false, capped = false
  for (const c of chunks) {
    if (onProgress?.(done++, total) === false) throw new Error("cancelled")
    if (blocks.length > cap) { capped = true; break }
    if ((loaded & 15) === 15 && over()) { truncated = true; break }
    loaded++
    const enbt = await readEntityChunk(world, c)
    if (enbt) {
      for (const e of enbt?.Entities ?? []) {
        const p = e.Pos
        // the user's y range, not the terrain's: flying entities sit above the
        // highest block and would vanish under the derived top
        if (!Array.isArray(p) || p[1] < yMin || p[1] > yMax + 1) continue
        const [esx, esz] = chunkShift.get(c.cx + "," + c.cz) ?? [0, 0]
        entities.push({ pos: [p[0] - x0 - esx, p[1] - y0, p[2] - z0 - esz], nbt: plain(e) })
      }
    }
    const nbt = await readChunk(world, c)
    const [csx, csz] = chunkShift.get(c.cx + "," + c.cz) ?? [0, 0]
    const beMap = new Map()
    for (const be of nbt.block_entities ?? []) {
      if (typeof be?.x !== "number") continue
      const { x, y, z, keepPacked, ...rest } = be
      beMap.set(`${x - x0 - csx},${y - y0},${z - z0 - csz}`, plain(rest))
    }
    const bx = c.cx * 16 - x0 - csx, bz = c.cz * 16 - z0 - csz
    for (const s of nbt.sections ?? []) {
      if (s.Y < minSec || s.Y > maxSec || !inRange(s)) continue
      const bs = s.block_states
      const pal = bs?.palette
      if (!pal) continue
      const sy = s.Y * 16 - y0
      const map = pal.map(e => REAL_AIR.test(e.id) ? -1 : stateFor(e))
      const hasBE = beMap.size > 0
      const put = (i, st) => {
        const y = sy + (i >> 8)
        if (y < 0 || y > relTop) return
        const pos = [bx + (i & 15), y, bz + ((i >> 4) & 15)]
        const b = { state: st, pos }
        if (hasBE) {
          const nb = beMap.get(pos.join(","))
          if (nb) b.nbt = nb
        }
        blocks.push(b)
      }
      if (pal.length === 1) {
        if (map[0] === -1) continue
        for (let i = 0; i < 4096; i++) put(i, map[0])
        continue
      }
      // indices are bit-packed low-to-high without spanning longs (1.16+);
      // nbt.js hands the longs over as [lo, hi] uint32 pairs
      const data = bs.data ?? []
      const bits = Math.max(4, 32 - Math.clz32(pal.length - 1))
      const vpl = Math.floor(64 / bits)
      const maskN = (1 << bits) - 1
      const longs = data.length >> 1
      let i = 0
      for (let li = 0; li < longs && i < 4096; li++) {
        const lo = data[li * 2], hi = data[li * 2 + 1]
        for (let j = 0; j < vpl && i < 4096; j++, i++) {
          const off = j * bits
          let v
          if (off + bits <= 32) v = (lo >>> off) & maskN
          else if (off >= 32) v = (hi >>> (off - 32)) & maskN
          else v = ((lo >>> off) | (hi << (32 - off))) & maskN
          const st = map[v]
          if (st !== -1 && st !== undefined) put(i, st)
        }
      }
    }
  }

  let size = [(maxCx - minCx + 1) * 16, relTop + 1, (maxCz - minCz + 1) * 16]
  let partsOut
  if (parts) {
    let mx = 0, mz = 0
    partsOut = parts.map(({ b, sx, sz }) => {
      const off = [b.x0 - x0 - sx, 0, b.z0 - z0 - sz]
      const psize = [b.x1 - b.x0, relTop + 1, b.z1 - b.z0]
      mx = Math.max(mx, off[0] + psize[0])
      mz = Math.max(mz, off[2] + psize[2])
      return { off, size: psize, world: [b.x0, b.z0] }
    })
    size = [mx, relTop + 1, mz]
  }

  const out = {
    worldOrigin: [x0, y0, z0],
    size,
    palette,
    blocks,
    entities,
    truncated,
    capped,
    oldSkipped,
    chunksLoaded: loaded,
    chunksTotal: chunks.length
  }
  if (partsOut) out.__parts = partsOut
  return out
}

// dense columnar chunk for streaming: palette plus a Uint16Array grid of
// palette index + 1 (0 = air), laid out y-major then (z*16 + x). No per-block
// objects; entries materialize later, only for cells that survive filtering
export async function chunkGrid(world, c, { yMin, yMax }) {
  const nbt = await readChunk(world, c)
  const h = yMax - yMin + 1
  const grid = new Uint16Array(256 * h)
  const palette = []
  const palKey = new Map()
  const beList = []
  let any = false
  if (nbt.sections) {
    for (const be of nbt.block_entities ?? []) {
      if (typeof be?.x !== "number" || be.y < yMin || be.y > yMax) continue
      const { x, y, z, keepPacked, ...rest } = be
      beList.push({ x, y, z, nbt: plain(rest) })
    }
    for (const s of nbt.sections) {
      const bs = s.block_states
      const pal = bs?.palette
      if (!pal || s.Y * 16 + 15 < yMin || s.Y * 16 > yMax) continue
      const sy = s.Y * 16
      const map = pal.map(e => {
        if (REAL_AIR.test(e.id)) return 0
        const k = e.id + "|" + (e.properties ? JSON.stringify(e.properties) : "")
        let gi = palKey.get(k)
        if (gi === undefined) {
          gi = palette.length + 1
          palKey.set(k, gi)
          palette.push({ id: e.id, properties: e.properties ?? null })
        }
        return gi
      })
      const yLo = Math.max(0, yMin - sy), yHi = Math.min(15, yMax - sy)
      if (pal.length === 1) {
        if (!map[0]) continue
        for (let y = yLo; y <= yHi; y++) grid.fill(map[0], (sy + y - yMin) * 256, (sy + y - yMin) * 256 + 256)
        any = true
        continue
      }
      const data = bs.data ?? []
      const bits = Math.max(4, 32 - Math.clz32(pal.length - 1))
      const vpl = Math.floor(64 / bits)
      const maskN = (1 << bits) - 1
      const longs = data.length >> 1
      let i = 0
      for (let li = 0; li < longs && i < 4096; li++) {
        const lo = data[li * 2], hi = data[li * 2 + 1]
        for (let j = 0; j < vpl && i < 4096; j++, i++) {
          const off = j * bits
          let v
          if (off + bits <= 32) v = (lo >>> off) & maskN
          else if (off >= 32) v = (hi >>> (off - 32)) & maskN
          else v = ((lo >>> off) | (hi << (32 - off))) & maskN
          const gi = map[v]
          if (!gi) continue
          const y = i >> 8
          if (y < yLo || y > yHi) continue
          grid[(sy + y - yMin) * 256 + (i & 255)] = gi
          any = true
        }
      }
    }
  }
  return { cx: c.cx, cz: c.cz, palette, grid, h, yMin, beList, empty: !any }
}

// merge chunk palettes into one tile palette; returns per-chunk local->global maps
export function mergeTilePalettes(chunkGrids) {
  const globalPalette = []
  const key = new Map()
  const maps = chunkGrids.map(cg => {
    const m = new Int32Array(cg.palette.length + 1)
    for (let i = 0; i < cg.palette.length; i++) {
      const e = cg.palette[i]
      const k = e.id + "|" + (e.properties ? JSON.stringify(e.properties) : "")
      let gi = key.get(k)
      if (gi === undefined) {
        gi = globalPalette.length + 1
        key.set(k, gi)
        globalPalette.push(e)
      }
      m[i + 1] = gi
    }
    return m
  })
  return { globalPalette, maps }
}

// combines own + ring chunk grids into one volume, drops buried cells, and
// materializes createScene entries only for survivors (own entries first).
// solidArr/doorArr/dynArr are per global-palette-index (+1) flags
export function assembleTile({ chunkGrids, maps, globalPalette, solidArr, doorArr, dynArr, gcx0, gcz0, chunksAcross, yMin, yMax, origin, ownTest }) {
  const W = chunksAcross * 16
  const H = yMax - yMin + 1
  const tile = new Uint16Array(W * H * W)
  for (let n = 0; n < chunkGrids.length; n++) {
    const cg = chunkGrids[n]
    if (cg.empty) continue
    const m = maps[n]
    const bx = (cg.cx - gcx0) * 16, bz = (cg.cz - gcz0) * 16
    for (let ly = 0; ly < H; ly++) {
      const src = ly * 256
      const dst = (ly * W + bz) * W + bx
      for (let z = 0; z < 16; z++) {
        const s = src + z * 16, d = dst + z * W
        for (let x = 0; x < 16; x++) {
          const gi = cg.grid[s + x]
          if (gi) tile[d + x] = m[gi]
        }
      }
    }
  }
  const solidAt = i => solidArr[tile[i]]
  const enc = (lx, ly, lz) =>
    lx > 0 && ly > 0 && lz > 0 && lx < W - 1 && ly < H - 1 && lz < W - 1 &&
    solidAt(((ly * W) + lz) * W + lx - 1) && solidAt(((ly * W) + lz) * W + lx + 1) &&
    solidAt((((ly - 1) * W) + lz) * W + lx) && solidAt((((ly + 1) * W) + lz) * W + lx) &&
    solidAt(((ly * W) + lz - 1) * W + lx) && solidAt(((ly * W) + lz + 1) * W + lx)
  const beMap = new Map()
  for (const cg of chunkGrids) {
    for (const be of cg.beList) beMap.set(be.x + "," + be.y + "," + be.z, be.nbt)
  }
  const wx0 = gcx0 * 16, wz0 = gcz0 * 16
  const own = [], ctx = [], doors = [], dynamics = [], nbts = []
  for (let ly = 0; ly < H; ly++) {
    for (let lz = 0; lz < W; lz++) {
      const row = (ly * W + lz) * W
      for (let lx = 0; lx < W; lx++) {
        const gi = tile[row + lx]
        if (!gi || enc(lx, ly, lz)) continue
        const e = globalPalette[gi - 1]
        const wx = wx0 + lx, wy = yMin + ly, wz = wz0 + lz
        const pos = [wx - origin[0], wy - origin[1], wz - origin[2]]
        const isOwn = ownTest(lx, lz)
        const nb = isOwn && beMap.size ? beMap.get(wx + "," + wy + "," + wz) : undefined
        if (isOwn && nb) nbts.push({ pos, nbt: nb })
        if (isOwn && doorArr[gi]) {
          doors.push({ pos, id: e.id, properties: e.properties ?? undefined })
          continue
        }
        if (isOwn && dynArr?.[gi]) {
          const d = { pos, id: e.id, properties: e.properties ?? undefined }
          if (nb) d.nbt = nb
          dynamics.push(d)
          continue
        }
        const entry = { id: e.id, pos }
        if (e.properties) entry.properties = e.properties
        if (isOwn) {
          if (nb) entry.nbt = nb
          own.push(entry)
        } else {
          entry.context = true
          ctx.push(entry)
        }
      }
    }
  }
  const occludes = (x, y, z) => {
    const lx = x + origin[0] - wx0, ly = y + origin[1] - yMin, lz = z + origin[2] - wz0
    return lx >= 0 && ly >= 0 && lz >= 0 && lx < W && ly < H && lz < W && !!solidArr[tile[(ly * W + lz) * W + lx]]
  }
  return { input: own.concat(ctx), tileCount: own.length, doors, dynamics, nbts, occludes, tile, W, H }
}

export const GRID = 1024

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uGrid;
uniform vec2 uW0;
uniform vec2 uView0;
uniform float uPx;
uniform float uCellW;
uniform float uLevel;
uniform float uTpc;
uniform float uH;
uniform vec4 uMarquee;
uniform vec3 uMarqueeCol;
uniform int uMarqueeOn;
out vec4 o;
const vec3 COLS[69] = vec3[](
  vec3(0.0), vec3(0.227, 0.227, 0.259), vec3(0.251, 0.251, 1.0), vec3(0.498, 0.698, 0.22),
  vec3(0.439, 0.439, 0.439), vec3(0.969, 0.914, 0.639), vec3(0.561, 0.467, 0.282),
  vec3(0.0, 0.486, 0.0), vec3(1.0, 1.0, 1.0), vec3(0.627, 0.627, 1.0),
  vec3(0.592, 0.427, 0.302), vec3(0.847, 0.498, 0.2), vec3(0.561, 0.808, 0.373),
  vec3(0.435, 0.125, 0.125), vec3(0.867, 0.902, 0.647), vec3(0.0), vec3(0.51, 0.51, 0.51),
  vec3(0.976, 1.0, 0.996), vec3(0.616, 0.616, 0.592), vec3(0.278, 0.31, 0.322),
  vec3(0.114, 0.114, 0.129), vec3(0.514, 0.329, 0.196), vec3(0.69, 0.18, 0.149),
  vec3(0.976, 0.502, 0.114), vec3(0.996, 0.847, 0.239), vec3(0.502, 0.78, 0.122),
  vec3(0.369, 0.486, 0.086), vec3(0.086, 0.612, 0.612), vec3(0.227, 0.702, 0.855),
  vec3(0.235, 0.267, 0.667), vec3(0.537, 0.196, 0.722), vec3(0.78, 0.306, 0.741),
  vec3(0.953, 0.545, 0.667),
  vec3(0.475, 0.094, 0.094), vec3(0.086, 0.494, 0.525), vec3(0.318, 0.243, 0.2),
  vec3(0.29, 0.29, 0.31), vec3(0.165, 0.145, 0.173), vec3(0.173, 0.086, 0.102),
  vec3(0.82, 0.694, 0.631), vec3(0.529, 0.42, 0.384), vec3(0.224, 0.161, 0.137),
  vec3(0.145, 0.086, 0.063), vec3(0.298, 0.196, 0.137), vec3(0.557, 0.235, 0.18),
  vec3(0.624, 0.322, 0.141), vec3(0.729, 0.522, 0.141), vec3(0.404, 0.459, 0.208),
  vec3(0.298, 0.322, 0.165), vec3(0.341, 0.361, 0.361), vec3(0.439, 0.424, 0.541),
  vec3(0.298, 0.243, 0.361), vec3(0.478, 0.286, 0.345), vec3(0.584, 0.341, 0.424),
  vec3(0.627, 0.302, 0.306), vec3(0.596, 0.369, 0.263), vec3(0.745, 0.4, 0.129),
  vec3(0.94, 0.7, 0.85), vec3(0.8, 0.65, 0.15), vec3(0.8, 0.45, 0.12),
  vec3(0.7, 0.2, 0.12),
  vec3(0.816, 0.918, 0.914), vec3(0.588, 0.376, 0.31), vec3(0.925, 0.914, 0.886),
  vec3(0.753, 0.42, 0.31), vec3(0.631, 0.494, 0.408), vec3(0.435, 0.631, 0.388),
  vec3(0.325, 0.643, 0.525), vec3(0.62, 0.65, 0.62));
void main() {
  vec2 sp = vec2(gl_FragCoord.x, uH - gl_FragCoord.y);
  vec2 cf = uView0 + sp / uPx;
  vec2 ch = floor(cf);
  vec2 cellf = clamp((cf - ch) * uPx / uCellW, 0.0, 0.999);
  vec2 sub = ch + (floor(cellf * uLevel) + 0.5) / uLevel;
  ivec2 t = ivec2(floor((sub - uW0) * uTpc));
  uint v = 0u;
  if (t.x >= 0 && t.y >= 0 && t.x < ${GRID} && t.y < ${GRID}) v = texelFetch(uGrid, t, 0).r;
  uint base = v & 127u;
  vec3 col = COLS[min(base, 68u)];
  if (base > 0u && uCellW < uPx) {
    vec2 f = (cf - ch) * uPx;
    if (f.x > uCellW || f.y > uCellW) col = vec3(0.0);
  }
  if ((v & 128u) != 0u) col = mix(col, vec3(1.0), 0.5);
  vec4 outc = vec4(col, 1.0);
  if (uMarqueeOn == 1 && cf.x >= uMarquee.x && cf.y >= uMarquee.y && cf.x < uMarquee.z && cf.y < uMarquee.w) {
    outc = vec4(outc.rgb * 0.82 + uMarqueeCol * 0.18, 1.0);
    vec2 r0 = (uMarquee.xy - uView0) * uPx;
    vec2 r1 = (uMarquee.zw - uView0) * uPx;
    if (sp.x < r0.x + 1.0 || sp.y < r0.y + 1.0 || sp.x > r1.x - 1.0 || sp.y > r1.y - 1.0) outc = vec4(uMarqueeCol, 1.0);
  }
  o = outc;
}`

export function createGridRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false })
  if (!gl) throw new Error("webgl2 unavailable")
  const compile = (type, src) => {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh))
    return sh
  }
  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
  gl.useProgram(prog)
  const U = n => gl.getUniformLocation(prog, n)
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.uniform1i(U("uGrid"), 0)

  return {
    canvas,
    data: new Uint8Array(GRID * GRID),
    resize(size) {
      canvas.width = canvas.height = size
      gl.viewport(0, 0, size, size)
      gl.uniform1f(U("uH"), size)
    },
    upload() {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, GRID, GRID, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.data)
    },
    draw({ w0x, w0z, cx0, cz0, px, cellW, level, tpc, marquee, marqueeOn }) {
      gl.uniform2f(U("uW0"), w0x, w0z)
      gl.uniform2f(U("uView0"), cx0, cz0)
      gl.uniform1f(U("uPx"), px)
      gl.uniform1f(U("uCellW"), cellW)
      gl.uniform1f(U("uLevel"), level)
      gl.uniform1f(U("uTpc"), tpc)
      if (marquee) {
        gl.uniform4f(U("uMarquee"), Math.min(marquee.aCx, marquee.bCx), Math.min(marquee.aCz, marquee.bCz),
          Math.max(marquee.aCx, marquee.bCx) + 1, Math.max(marquee.aCz, marquee.bCz) + 1)
        const c = marqueeOn ? [0.298, 0.553, 1] : [0.878, 0.416, 0.416]
        gl.uniform3f(U("uMarqueeCol"), c[0], c[1], c[2])
      }
      gl.uniform1i(U("uMarqueeOn"), marquee ? 1 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
  }
}
