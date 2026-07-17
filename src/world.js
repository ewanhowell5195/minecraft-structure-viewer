import { loadLibrary } from "./lib.js"
import { readNBT } from "./nbt.js"

const AIR = /(^|:)(air|cave_air|void_air)$/

async function inflate(data, format) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export const unzipEntry = entry => entry.method === 8 ? inflate(entry.data, "deflate-raw") : entry.data

export async function readWorldZip(buf) {
  const lib = await loadLibrary()
  const files = lib.parseZip(new Uint8Array(buf))
  const prefixes = new Set()
  for (const p of files.keys()) {
    const m = p.match(/^(.*?)region\/r\.-?\d+\.-?\d+\.mca$/)
    if (m) prefixes.add(m[1])
  }
  if (!prefixes.size) throw new Error("no region files found (is this a world zip?)")
  const prefix = [...prefixes].sort((a, b) => (/DIM/i.test(a) - /DIM/i.test(b)) || a.length - b.length)[0]

  let name = ""
  const levelEntry = files.get(prefix + "level.dat")
  if (levelEntry) {
    try { name = (await readNBT(await unzipEntry(levelEntry))).Data?.LevelName ?? "" } catch {}
  }

  const regionBufs = new Map()
  const chunks = []
  for (const [p, entry] of files) {
    const m = p.match(/^(.*?)region\/r\.(-?\d+)\.(-?\d+)\.mca$/)
    if (!m || m[1] !== prefix) continue
    const bytes = await unzipEntry(entry)
    if (bytes.length < 8192) continue
    const key = m[2] + "," + m[3]
    regionBufs.set(key, bytes)
    scanRegion(bytes, Number(m[2]), Number(m[3]), key, chunks)
  }
  if (!chunks.length) throw new Error("the region files contain no chunks")

  const structures = new Map()
  for (const [p, entry] of files) {
    const m = p.match(/^(.*?)generated\/([^/]+)\/structures\/(.+)\.nbt$/)
    if (!m || m[1] !== prefix) continue
    structures.set("world/" + (m[2] === "minecraft" ? "" : m[2] + "/") + m[3], entry)
  }
  return { name, regionBufs, chunks, structures }
}

// the 8KB region header holds 1024 chunk location entries
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
  return { name: "", regionBufs: new Map([[key, bytes]]), chunks, structures: new Map() }
}

async function readChunk(world, chunk) {
  const bytes = world.regionBufs.get(chunk.region)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const loc = dv.getUint32(chunk.index * 4)
  const off = (loc >>> 8) * 4096
  const len = dv.getUint32(off)
  const method = bytes[off + 4]
  const payload = bytes.subarray(off + 5, off + 4 + len)
  if (method === 3) return readNBT(payload)
  if (method === 1 || method === 2) return readNBT(await inflate(payload, method === 1 ? "gzip" : "deflate"))
  throw new Error(`unsupported chunk compression ${method}`)
}

const PLANTS = new Set(["poppy", "dandelion", "oxeye_daisy", "azure_bluet", "cornflower", "allium",
  "lilac", "peony", "sunflower", "wither_rose", "wheat", "beetroots", "carrots", "potatoes",
  "sugar_cane", "cactus", "vine"])
function surfaceCode(name) {
  const n = name.replace(/^minecraft:/, "")
  if (n === "water" || n === "kelp" || n === "kelp_plant" || n.endsWith("seagrass") || n === "lily_pad") return 2
  if (n === "grass_block" || n === "moss_block" || n === "moss_carpet") return 3
  if (n === "lava" || n === "magma_block") return 11
  if (n === "snow" || n === "snow_block" || n === "powder_snow") return 8
  if (n === "bedrock") return 15
  if (n === "netherrack") return 13
  if (n.startsWith("end_stone")) return 14
  if (n.endsWith("gravel")) return 16
  if (n.endsWith("ice")) return 9
  if (n.endsWith("sand") || n.endsWith("sandstone")) return 5
  if (n.endsWith("_log") || n.endsWith("_wood") || n.endsWith("_stem") || n.endsWith("_hyphae") || n.endsWith("_planks") || n.startsWith("bamboo")) return 6
  if (n.endsWith("_leaves")) return 7
  if (n === "dirt" || n.endsWith("_dirt") || n === "dirt_path" || n === "podzol" || n === "mud" || n === "mycelium" || n === "farmland") return 10
  if (n.endsWith("grass") || n.endsWith("fern") || n.endsWith("bush") || n.endsWith("sapling") || n.endsWith("_tulip") ||
    n.endsWith("_orchid") || n.endsWith("_petals") || n.endsWith("flower") || n.startsWith("sweet_berry") || PLANTS.has(n)) return 12
  return 4
}

export async function chunkSurface(world, chunk) {
  const nbt = await readChunk(world, chunk)
  const sections = (nbt.sections ?? []).filter(s => s.block_states?.palette).sort((a, b) => b.Y - a.Y)
  const cols = new Uint8Array(256)
  let remaining = 256
  for (const s of sections) {
    if (!remaining) break
    const pal = s.block_states.palette
    const airMask = pal.map(e => AIR.test(e.Name))
    if (!airMask.includes(false)) continue
    const codes = pal.map(e => surfaceCode(e.Name))
    let idx = null
    if (pal.length > 1) {
      idx = new Uint16Array(4096)
      const data = s.block_states.data ?? []
      const bits = Math.max(4, 32 - Math.clz32(pal.length - 1))
      const vpl = Math.floor(64 / bits)
      const bigBits = BigInt(bits), mask = (1n << bigBits) - 1n
      for (let i = 0; i < 4096; i++) {
        const l = data[(i / vpl) | 0]
        if (l === undefined) break
        idx[i] = Number(BigInt.asUintN(64, l) >> (BigInt(i % vpl) * bigBits) & mask)
      }
    }
    for (let col = 0; col < 256; col++) {
      if (cols[col]) continue
      for (let y = 15; y >= 0; y--) {
        const pi = idx ? idx[(y << 8) | col] : 0
        if (airMask[pi]) continue
        cols[col] = codes[pi]
        remaining--
        break
      }
    }
  }
  if (remaining === 256) return null
  const mode = arr => {
    const counts = new Uint16Array(32)
    let best = 0, bn = 0
    for (const c of arr) {
      if (!c) continue
      if (++counts[c] > bn) { bn = counts[c]; best = c }
    }
    return best
  }
  const sub = new Uint8Array(64)
  const quad = new Uint8Array(4)
  for (let sz = 0; sz < 8; sz++) for (let sx = 0; sx < 8; sx++) {
    quad[0] = cols[(sz * 2) * 16 + sx * 2]
    quad[1] = cols[(sz * 2) * 16 + sx * 2 + 1]
    quad[2] = cols[(sz * 2 + 1) * 16 + sx * 2]
    quad[3] = cols[(sz * 2 + 1) * 16 + sx * 2 + 1]
    sub[sz * 8 + sx] = mode(quad)
  }
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

export async function buildSelection(world, selected, { yMin = -Infinity, yMax = Infinity } = {}) {
  const chunks = world.chunks.filter(c => selected.has(c.cx + "," + c.cz))
  if (!chunks.length) throw new Error("no chunks selected")
  const parsed = []
  for (const c of chunks) {
    const nbt = await readChunk(world, c)
    if (!nbt.sections) throw new Error("this world's chunks are too old (1.18+ only)")
    parsed.push({ c, nbt })
  }

  let minCx = Infinity, maxCx = -Infinity, minCz = Infinity, maxCz = -Infinity
  for (const c of chunks) {
    minCx = Math.min(minCx, c.cx); maxCx = Math.max(maxCx, c.cx)
    minCz = Math.min(minCz, c.cz); maxCz = Math.max(maxCz, c.cz)
  }
  const inRange = s => s.Y * 16 + 15 >= yMin && s.Y * 16 <= yMax
  let minSec = Infinity, maxSec = -Infinity
  for (const { nbt } of parsed) {
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

  const beMap = new Map()
  for (const { nbt } of parsed) {
    for (const be of nbt.block_entities ?? []) {
      if (typeof be?.x !== "number") continue
      const { x, y, z, keepPacked, ...rest } = be
      beMap.set(`${x - x0},${y - y0},${z - z0}`, plain(rest))
    }
  }

  const blocks = []
  const relTop = yTop - y0
  for (const { c, nbt } of parsed) {
    const bx = c.cx * 16 - x0, bz = c.cz * 16 - z0
    for (const s of nbt.sections) {
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
    entities: []
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
uniform float uH;
uniform vec4 uMarquee;
uniform vec3 uMarqueeCol;
uniform int uMarqueeOn;
out vec4 o;
const vec3 COLS[17] = vec3[](
  vec3(0.0), vec3(0.227, 0.227, 0.259), vec3(0.251, 0.251, 1.0), vec3(0.498, 0.698, 0.22),
  vec3(0.439, 0.439, 0.439), vec3(0.969, 0.914, 0.639), vec3(0.561, 0.467, 0.282),
  vec3(0.0, 0.486, 0.0), vec3(1.0, 1.0, 1.0), vec3(0.627, 0.627, 1.0),
  vec3(0.592, 0.427, 0.302), vec3(0.847, 0.498, 0.2), vec3(0.561, 0.808, 0.373),
  vec3(0.435, 0.125, 0.125), vec3(0.867, 0.902, 0.647), vec3(0.0), vec3(0.51, 0.51, 0.51));
void main() {
  vec2 sp = vec2(gl_FragCoord.x, uH - gl_FragCoord.y);
  vec2 cf = uView0 + sp / uPx;
  vec2 ch = floor(cf);
  vec2 cellf = clamp((cf - ch) * uPx / uCellW, 0.0, 0.999);
  vec2 sub = ch + (floor(cellf * uLevel) + 0.5) / uLevel;
  ivec2 t = ivec2(floor((sub - uW0) * 8.0));
  uint v = 0u;
  if (t.x >= 0 && t.y >= 0 && t.x < ${GRID} && t.y < ${GRID}) v = texelFetch(uGrid, t, 0).r;
  uint base = v & 31u;
  vec3 col = COLS[min(base, 16u)];
  if (base > 0u && uCellW < uPx) {
    vec2 f = (cf - ch) * uPx;
    if (f.x > uCellW || f.y > uCellW) col = vec3(0.0);
  }
  if ((v & 32u) != 0u) col = mix(col, vec3(1.0), 0.5);
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
    draw({ w0x, w0z, cx0, cz0, px, cellW, level, marquee, marqueeOn }) {
      gl.uniform2f(U("uW0"), w0x, w0z)
      gl.uniform2f(U("uView0"), cx0, cz0)
      gl.uniform1f(U("uPx"), px)
      gl.uniform1f(U("uCellW"), cellW)
      gl.uniform1f(U("uLevel"), level)
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
