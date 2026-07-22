import { readNBT } from "./nbt.js"

const AIR = /(^|:)(air|cave_air|void_air)$/

async function inflate(data, format) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const sliceBytes = async (blob, start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer())

// central directory only (zip64 aware); entry bytes stay on disk until read,
// so multi-GB world zips never need the whole file in memory
export async function parseZipBlob(blob) {
  const size = blob.size
  const tail = await sliceBytes(blob, Math.max(0, size - 66000), size)
  let e = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { e = i; break }
  }
  if (e === -1) throw new Error("not a zip file (no end of central directory record)")
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let count = tdv.getUint16(e + 10, true)
  let cdSize = tdv.getUint32(e + 12, true)
  let cdOff = tdv.getUint32(e + 16, true)
  if ((cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) && e >= 20 && tdv.getUint32(e - 20, true) === 0x07064b50) {
    const off64 = Number(tdv.getBigUint64(e - 12, true))
    const rec = await sliceBytes(blob, off64, off64 + 56)
    const rdv = new DataView(rec.buffer)
    if (rdv.getUint32(0, true) === 0x06064b50) {
      count = Number(rdv.getBigUint64(32, true))
      cdSize = Number(rdv.getBigUint64(40, true))
      cdOff = Number(rdv.getBigUint64(48, true))
    }
  }
  const cd = await sliceBytes(blob, cdOff, cdOff + cdSize)
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  const td = new TextDecoder()
  const files = new Map()
  let o = 0
  for (let i = 0; i < count && o + 46 <= cd.length; i++) {
    const nameLen = dv.getUint16(o + 28, true)
    const extraLen = dv.getUint16(o + 30, true)
    const commentLen = dv.getUint16(o + 32, true)
    const filePath = td.decode(cd.subarray(o + 46, o + 46 + nameLen))
    if (!filePath.endsWith("/")) {
      const method = dv.getUint16(o + 10, true)
      let compressedSize = dv.getUint32(o + 20, true)
      const uncompressedSize = dv.getUint32(o + 24, true)
      let localOffset = dv.getUint32(o + 42, true)
      if (compressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF) {
        let eo = o + 46 + nameLen
        const end = eo + extraLen
        while (eo + 4 <= end) {
          const id = dv.getUint16(eo, true), sz = dv.getUint16(eo + 2, true)
          if (id === 1) {
            let fo = eo + 4
            if (uncompressedSize === 0xFFFFFFFF) fo += 8
            if (compressedSize === 0xFFFFFFFF) {
              compressedSize = Number(dv.getBigUint64(fo, true))
              fo += 8
            }
            if (localOffset === 0xFFFFFFFF) localOffset = Number(dv.getBigUint64(fo, true))
            break
          }
          eo += 4 + sz
        }
      }
      files.set(filePath, { method, blob, localOffset, compressedSize })
    }
    o += 46 + nameLen + extraLen + commentLen
  }
  return files
}

async function entryStart(entry) {
  const head = await sliceBytes(entry.blob, entry.localOffset, entry.localOffset + 30)
  const dv = new DataView(head.buffer)
  return entry.localOffset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true)
}

async function entryData(entry) {
  if (entry.data) return entry.data
  const start = await entryStart(entry)
  return sliceBytes(entry.blob, start, start + entry.compressedSize)
}

export const unzipEntry = async entry => {
  const data = await entryData(entry)
  return entry.method === 8 ? inflate(data, "deflate-raw") : data
}

// the first `want` decompressed bytes without inflating the rest: region
// headers are 8KB out of multi-MB entries
async function entryPrefix(entry, want) {
  if (entry.data) return (await unzipEntry(entry)).subarray(0, want)
  const start = await entryStart(entry)
  if (entry.method !== 8) return sliceBytes(entry.blob, start, start + Math.min(want, entry.compressedSize))
  const reader = entry.blob.slice(start, start + entry.compressedSize).stream()
    .pipeThrough(new DecompressionStream("deflate-raw")).getReader()
  const chunks = []
  let got = 0
  while (got < want) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
  }
  reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(got, want))
  let off = 0
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - off)
    out.set(c.subarray(0, n), off)
    off += n
    if (off >= out.length) break
  }
  return out
}

const DIM_ORDER = { overworld: 0, the_nether: 1, the_end: 2 }

export async function readWorldZip(blob, onProgress) {
  const files = await parseZipBlob(blob)
  const prefixes = new Set()
  for (const p of files.keys()) {
    const m = p.match(/^(.*?)region\/r\.-?\d+\.-?\d+\.mca$/)
    if (m) prefixes.add(m[1])
  }
  if (!prefixes.size) throw new Error("no region files found (is this a world zip?)")

  const dims = []
  const modern = [...prefixes].filter(p => /(^|\/)dimensions\/[^/]+\/.+\/$/.test(p))
  if (modern.length) {
    for (const p of modern) {
      const m = p.match(/^(.*?)dimensions\/([^/]+)\/(.+)\/$/)
      dims.push({ id: m[2] === "minecraft" ? m[3] : m[2] + ":" + m[3], prefix: p, root: m[1] })
    }
  } else {
    const over = [...prefixes].filter(p => !/DIM-?1\/$/.test(p)).sort((a, b) => a.length - b.length)[0]
    const base = over ?? [...prefixes][0].replace(/DIM-?1\/$/, "")
    if (over !== undefined) dims.push({ id: "overworld", prefix: over, root: base })
    if (prefixes.has(base + "DIM-1/")) dims.push({ id: "the_nether", prefix: base + "DIM-1/", root: base })
    if (prefixes.has(base + "DIM1/")) dims.push({ id: "the_end", prefix: base + "DIM1/", root: base })
  }
  dims.sort((a, b) => (DIM_ORDER[a.id] ?? 3) - (DIM_ORDER[b.id] ?? 3) || a.root.length - b.root.length || a.id.localeCompare(b.id))
  const root = dims[0].root

  let name = ""
  const levelEntry = files.get(root + "level.dat")
  if (levelEntry) {
    try { name = (await readNBT(await unzipEntry(levelEntry))).Data?.LevelName ?? "" } catch {}
  }

  const structures = new Map()
  const structList = []
  for (const [p, entry] of files) {
    const m = p.match(/^(.*?)generated\/([^/]+)\/structures?\/(.+)\.nbt$/)
    if (!m || m[1] !== root) continue
    const rel = "world/" + (m[2] === "minecraft" ? "" : m[2] + "/") + m[3]
    structures.set(rel, entry)
    structList.push({ rel, ns: m[2], path: m[3] })
  }
  const data = await readDimension(files, dims[0].prefix, onProgress)
  return { name, structures, structList, files, root, dims, dimension: dims[0].id, ...data }
}

async function readDimension(files, prefix, onProgress) {
  const regions = [], eRegions = []
  for (const [p, entry] of files) {
    const m = p.match(/^(.*?)region\/r\.(-?\d+)\.(-?\d+)\.mca$/)
    if (m && m[1] === prefix) regions.push([m, entry])
    const em = p.match(/^(.*?)entities\/r\.(-?\d+)\.(-?\d+)\.mca$/)
    if (em && em[1] === prefix) eRegions.push([em, entry])
  }
  const regionBufs = new Map()
  const entityBufs = new Map()
  const chunks = []
  let done = 0
  const total = regions.length + eRegions.length
  for (const [m, entry] of regions) {
    onProgress?.(done++, total)
    const header = await entryPrefix(entry, 4096)
    if (header.length < 4096) continue
    const key = m[2] + "," + m[3]
    regionBufs.set(key, entry)
    scanRegion(header, Number(m[2]), Number(m[3]), key, chunks)
  }
  if (!chunks.length) throw new Error("the region files contain no chunks")
  for (const [m, entry] of eRegions) {
    onProgress?.(done++, total)
    entityBufs.set(m[2] + "," + m[3], entry)
  }
  return { regionBufs, entityBufs, chunks, regionCache: new Map() }
}

export async function switchDimension(world, id, onProgress) {
  const d = world.dims?.find(d => d.id === id)
  if (!d) throw new Error("unknown dimension " + id)
  const data = await readDimension(world.files, d.prefix, onProgress)
  return { ...world, dimension: id, ...data }
}

function scanRegion(bytes, rx, rz, key, chunks) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < 1024; i++) {
    if (dv.getUint32(i * 4) === 0) continue
    chunks.push({ cx: rx * 32 + (i & 31), cz: rz * 32 + (i >> 5), region: key, index: i })
  }
}

export function readRegionFile(buf, fileName) {
  const bytes = new Uint8Array(buf)
  if (bytes.length < 8192) throw new Error("not a region file")
  const m = fileName.match(/r\.(-?\d+)\.(-?\d+)\.mca$/i)
  const rx = m ? Number(m[1]) : 0, rz = m ? Number(m[2]) : 0
  const key = rx + "," + rz
  const chunks = []
  scanRegion(bytes, rx, rz, key, chunks)
  if (!chunks.length) throw new Error("the region file contains no chunks")
  return { name: "", regionBufs: new Map([[key, bytes]]), entityBufs: new Map(), chunks, structures: new Map(), regionCache: new Map() }
}

async function readChunkFrom(bytes, index) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const loc = dv.getUint32(index * 4)
  if (!loc) return null
  const off = (loc >>> 8) * 4096
  const len = dv.getUint32(off)
  const method = bytes[off + 4]
  const payload = bytes.subarray(off + 5, off + 4 + len)
  if (method === 3) return readNBT(payload)
  if (method === 1 || method === 2) return readNBT(await inflate(payload, method === 1 ? "gzip" : "deflate"))
  throw new Error(`unsupported chunk compression ${method}`)
}

// lazy worlds keep zip entries in the bufs maps; inflated regions live in a
// small LRU so a browse can't accumulate the whole world in memory. The cap is
// byte-based: full-height regions inflate to 100MB+ each, so an entry-count cap
// alone can balloon into gigabytes
const REGION_CACHE_MAX = 24
const REGION_CACHE_BYTES = 320 * 1024 * 1024
async function regionData(world, kind, key) {
  const src = kind === "entity" ? world.entityBufs : world.regionBufs
  const v = src?.get(key)
  if (!v) return null
  if (v instanceof Uint8Array) return v
  const cache = world.regionCache
  const ck = kind + ":" + key
  const hit = cache.get(ck)
  if (hit) {
    cache.delete(ck)
    cache.set(ck, hit)
    return hit
  }
  const bytes = await unzipEntry(v)
  cache.set(ck, bytes)
  let total = 0
  for (const b of cache.values()) total += b.byteLength
  while ((cache.size > REGION_CACHE_MAX || total > REGION_CACHE_BYTES) && cache.size > 1) {
    const k0 = cache.keys().next().value
    total -= cache.get(k0).byteLength
    cache.delete(k0)
  }
  return bytes
}

export const readChunk = async (world, chunk) => readChunkFrom(await regionData(world, "region", chunk.region), chunk.index)

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

// scratch for the packed-index halves; palettes cap at 4096 so 820 longs is the most
const u32Scratch = new Uint32Array(2048)

export async function chunkYExtent(world, chunk) {
  const nbt = await readChunk(world, chunk)
  let top = -Infinity, bottom = Infinity
  for (const s of nbt.sections ?? []) {
    const pal = s.block_states?.palette
    if (!pal || !pal.some(e => !AIR.test(e?.Name ?? ""))) continue
    if (s.Y * 16 + 15 > top) top = s.Y * 16 + 15
    if (s.Y * 16 < bottom) bottom = s.Y * 16
  }
  return top === -Infinity ? null : { top, bottom }
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
    const airMask = pal.map(e => AIR.test(e.Name))
    if (!airMask.includes(false)) continue
    const codes = pal.map(e => surfaceCode(e.Name))
    const wts = pal.map(e => manmade(e.Name) ? 3 : 1)
    // longs become uint32 pairs once, then only unresolved columns get probed:
    // decoding whole sections through BigInt was most of the scan cost
    let bits = 0, vpl = 0, mask = 0, u32 = null
    if (pal.length > 1) {
      const data = s.block_states.data ?? []
      bits = Math.max(4, 32 - Math.clz32(pal.length - 1))
      vpl = Math.floor(64 / bits)
      mask = (1 << bits) - 1
      u32 = u32Scratch
      for (let i = 0; i < data.length; i++) {
        const l = BigInt.asUintN(64, data[i])
        u32[i * 2] = Number(l & 0xffffffffn)
        u32[i * 2 + 1] = Number(l >> 32n)
      }
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
      if (!inRange(s) || !pal || pal.every(e => AIR.test(e.Name))) continue
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
    const k = e.Name + "|" + JSON.stringify(e.Properties ?? null)
    let i = palIdx.get(k)
    if (i === undefined) {
      i = palette.length
      palette.push(e.Properties ? { Name: e.Name, Properties: e.Properties } : { Name: e.Name })
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
    const ebytes = await regionData(world, "entity", c.region)
    if (ebytes && ebytes.length >= 8192) {
      const enbt = await readChunkFrom(ebytes, c.index)
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
      const map = pal.map(e => AIR.test(e.Name) ? -1 : stateFor(e))
      const put = (i, st) => {
        const y = sy + (i >> 8)
        if (y < 0 || y > relTop) return
        const pos = [bx + (i & 15), y, bz + ((i >> 4) & 15)]
        const b = { state: st, pos }
        const nb = beMap.get(pos.join(","))
        if (nb) b.nbt = nb
        blocks.push(b)
      }
      if (pal.length === 1) {
        if (map[0] === -1) continue
        for (let i = 0; i < 4096; i++) put(i, map[0])
        continue
      }
      // indices are bit-packed low-to-high without spanning longs (1.16+)
      const data = bs.data ?? []
      const bits = Math.max(4, 32 - Math.clz32(pal.length - 1))
      const vpl = Math.floor(64 / bits)
      const bigBits = BigInt(bits), mask = (1n << bigBits) - 1n
      for (let i = 0; i < 4096; i++) {
        const l = data[(i / vpl) | 0]
        if (l === undefined) break
        const st = map[Number(BigInt.asUintN(64, l) >> (BigInt(i % vpl) * bigBits) & mask)]
        if (st !== -1 && st !== undefined) put(i, st)
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

// drop blocks buried under fully-occluding neighbors on every side. flags[i]
// marks block i as a full opaque cube. Returns the kept blocks plus an
// occludes(x,y,z) lookup over the solid mask, which createScene consults
// (externalOcclusion) so faces against dropped blocks still cull.
export function dropEnclosed(blocks, flags) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const b of blocks) {
    const p = b.pos
    if (p[0] < minX) minX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[2] < minZ) minZ = p[2]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] > maxY) maxY = p[1]
    if (p[2] > maxZ) maxZ = p[2]
  }
  const w = maxX - minX + 1, h = maxY - minY + 1, d = maxZ - minZ + 1
  if (!blocks.length || w * h * d > 50_000_000) return { blocks, occludes: null }
  const solid = new Uint8Array(w * h * d)
  const at = (x, y, z) => (z * h + y) * w + x
  for (let i = 0; i < blocks.length; i++) {
    if (!flags[i]) continue
    const p = blocks[i].pos
    solid[at(p[0] - minX, p[1] - minY, p[2] - minZ)] = 1
  }
  const enc = (x, y, z) =>
    x > 0 && y > 0 && z > 0 && x < w - 1 && y < h - 1 && z < d - 1 &&
    solid[at(x - 1, y, z)] && solid[at(x + 1, y, z)] &&
    solid[at(x, y - 1, z)] && solid[at(x, y + 1, z)] &&
    solid[at(x, y, z - 1)] && solid[at(x, y, z + 1)]
  const out = []
  for (let i = 0; i < blocks.length; i++) {
    const p = blocks[i].pos
    if (enc(p[0] - minX, p[1] - minY, p[2] - minZ)) continue
    out.push(blocks[i])
  }
  const occludes = (x, y, z) => {
    const lx = x - minX, ly = y - minY, lz = z - minZ
    return lx >= 0 && ly >= 0 && lz >= 0 && lx < w && ly < h && lz < d && !!solid[at(lx, ly, lz)]
  }
  return { blocks: out, occludes }
}

// one chunk's blocks in createScene entry form, world block coordinates, for
// the streaming tiles; block entity nbt rides along so banners/shelves render
export async function chunkBlocks(world, c, { yMin = -Infinity, yMax = Infinity } = {}) {
  const nbt = await readChunk(world, c)
  const blocks = []
  if (!nbt.sections) return blocks
  const beMap = new Map()
  for (const be of nbt.block_entities ?? []) {
    if (typeof be?.x !== "number") continue
    const { x, y, z, keepPacked, ...rest } = be
    beMap.set(`${x},${y},${z}`, plain(rest))
  }
  const bx = c.cx * 16, bz = c.cz * 16
  for (const s of nbt.sections) {
    const bs = s.block_states
    const pal = bs?.palette
    if (!pal || s.Y * 16 + 15 < yMin || s.Y * 16 > yMax) continue
    const sy = s.Y * 16
    const entries = pal.map(e => AIR.test(e.Name) ? null : e)
    const hasBE = beMap.size > 0
    const put = (i, e) => {
      const y = sy + (i >> 8)
      if (y < yMin || y > yMax) return
      const pos = [bx + (i & 15), y, bz + ((i >> 4) & 15)]
      const b = { id: e.Name, pos }
      if (e.Properties) b.properties = e.Properties
      if (hasBE) {
        const nb = beMap.get(pos.join(","))
        if (nb) b.nbt = nb
      }
      blocks.push(b)
    }
    if (pal.length === 1) {
      if (!entries[0]) continue
      for (let i = 0; i < 4096; i++) put(i, entries[0])
      continue
    }
    const data = bs.data ?? []
    const bits = Math.max(4, 32 - Math.clz32(pal.length - 1))
    const vpl = Math.floor(64 / bits)
    const maskN = (1 << bits) - 1
    const M32 = 0xFFFFFFFFn
    let i = 0
    for (let li = 0; li < data.length && i < 4096; li++) {
      const l = data[li]
      const lo = Number(l & M32), hi = Number((l >> 32n) & M32)
      for (let j = 0; j < vpl && i < 4096; j++, i++) {
        const off = j * bits
        let v
        if (off + bits <= 32) v = (lo >>> off) & maskN
        else if (off >= 32) v = (hi >>> (off - 32)) & maskN
        else v = ((lo >>> off) | (hi << (32 - off))) & maskN
        const e = entries[v]
        if (e) put(i, e)
      }
    }
  }
  return blocks
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
