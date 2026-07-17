import { loadLibrary } from "./lib.js"
import { readNBT } from "./nbt.js"

const AIR = /(^|:)(air|cave_air|void_air)$/

async function inflate(data, format) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export const unzipEntry = entry => entry.method === 8 ? inflate(entry.data, "deflate-raw") : entry.data

export async function readWorldZip(buf, onProgress) {
  const lib = await loadLibrary()
  const files = lib.parseZip(new Uint8Array(buf))
  const prefixes = new Set()
  for (const p of files.keys()) {
    const m = p.match(/^(.*?)region\/r\.-?\d+\.-?\d+\.mca$/)
    if (m) prefixes.add(m[1])
  }
  if (!prefixes.size) throw new Error("no region files found (is this a world zip?)")
  const rank = p => /dimensions\/minecraft\/overworld\//.test(p) ? 0 : /DIM|the_nether|the_end/i.test(p) ? 2 : 1
  const prefix = [...prefixes].sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0]
  const root = prefix.replace(/dimensions\/[^/]+\/[^/]+\/$/, "")

  let name = ""
  const levelEntry = files.get(root + "level.dat")
  if (levelEntry) {
    try { name = (await readNBT(await unzipEntry(levelEntry))).Data?.LevelName ?? "" } catch {}
  }

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
    const bytes = await unzipEntry(entry)
    if (bytes.length < 8192) continue
    const key = m[2] + "," + m[3]
    regionBufs.set(key, bytes)
    scanRegion(bytes, Number(m[2]), Number(m[3]), key, chunks)
  }
  if (!chunks.length) throw new Error("the region files contain no chunks")
  for (const [m, entry] of eRegions) {
    onProgress?.(done++, total)
    const bytes = await unzipEntry(entry)
    if (bytes.length >= 8192) entityBufs.set(m[2] + "," + m[3], bytes)
  }

  const structures = new Map()
  for (const [p, entry] of files) {
    const m = p.match(/^(.*?)generated\/([^/]+)\/structures\/(.+)\.nbt$/)
    if (!m || m[1] !== root) continue
    structures.set("world/" + (m[2] === "minecraft" ? "" : m[2] + "/") + m[3], entry)
  }
  return { name, regionBufs, entityBufs, chunks, structures }
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
  return { name: "", regionBufs: new Map([[key, bytes]]), entityBufs: new Map(), chunks, structures: new Map() }
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

export const readChunk = (world, chunk) => readChunkFrom(world.regionBufs.get(chunk.region), chunk.index)

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

export async function chunkSurface(world, chunk) {
  const nbt = await readChunk(world, chunk)
  const sections = (nbt.sections ?? []).filter(s => s.block_states?.palette).sort((a, b) => b.Y - a.Y)
  const cols = new Uint8Array(256)
  const colW = new Uint8Array(256)
  let remaining = 256
  for (const s of sections) {
    if (!remaining) break
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
      for (let y = 15; y >= 0; y--) {
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

export async function buildSelection(world, selected, { yMin = -Infinity, yMax = Infinity, budget = Infinity, cap = Infinity } = {}, onProgress) {
  const chunks = world.chunks.filter(c => selected.has(c.cx + "," + c.cz))
  if (!chunks.length) throw new Error("no chunks selected")

  let minCx = Infinity, maxCx = -Infinity, minCz = Infinity, maxCz = -Infinity
  for (const c of chunks) {
    minCx = Math.min(minCx, c.cx); maxCx = Math.max(maxCx, c.cx)
    minCz = Math.min(minCz, c.cz); maxCz = Math.max(maxCz, c.cz)
  }
  const inRange = s => s.Y * 16 + 15 >= yMin && s.Y * 16 <= yMax
  // two passes re-reading each chunk so only one parsed NBT lives at a time:
  // holding thousands of them was a large slice of the memory that big loads burn
  let minSec = Infinity, maxSec = -Infinity
  let done = 0
  const total = chunks.length * 2
  for (const c of chunks) {
    if (onProgress?.(done++, total) === false) throw new Error("cancelled")
    const nbt = await readChunk(world, c)
    if (!nbt.sections) {
      if (nbt.Level) {
        const err = new Error("this world's chunks are too old (1.18+ only)")
        err.oldChunks = true
        throw err
      }
      continue
    }
    for (const s of nbt.sections) {
      const pal = s.block_states?.palette
      if (!inRange(s) || !pal || pal.every(e => AIR.test(e.Name))) continue
      minSec = Math.min(minSec, s.Y)
      maxSec = Math.max(maxSec, s.Y)
    }
  }
  if (minSec === Infinity) throw new Error("the selected chunks are empty in this y range")
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
    const ebytes = world.entityBufs?.get(c.region)
    if (ebytes) {
      const enbt = await readChunkFrom(ebytes, c.index)
      for (const e of enbt?.Entities ?? []) {
        const p = e.Pos
        // the user's y range, not the terrain's: flying entities sit above the
        // highest block and would vanish under the derived top
        if (!Array.isArray(p) || p[1] < yMin || p[1] > yMax + 1) continue
        entities.push({ pos: [p[0] - x0, p[1] - y0, p[2] - z0], nbt: plain(e) })
      }
    }
    const nbt = await readChunk(world, c)
    const beMap = new Map()
    for (const be of nbt.block_entities ?? []) {
      if (typeof be?.x !== "number") continue
      const { x, y, z, keepPacked, ...rest } = be
      beMap.set(`${x - x0},${y - y0},${z - z0}`, plain(rest))
    }
    const bx = c.cx * 16 - x0, bz = c.cz * 16 - z0
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

  return {
    size: [(maxCx - minCx + 1) * 16, relTop + 1, (maxCz - minCz + 1) * 16],
    palette,
    blocks,
    entities,
    truncated,
    capped,
    chunksLoaded: loaded,
    chunksTotal: chunks.length
  }
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
