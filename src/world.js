import { loadLibrary } from "./lib.js"
import { readNBT } from "./nbt.js"

// Anvil world reading: list a world zip's chunks from the region headers,
// then turn a selection of them into the internal structure format. Modern
// chunks only (1.18+, sections with block_states); older worlds get a clear
// error instead of garbage.

const AIR = /(^|:)(air|cave_air|void_air)$/

async function inflate(data, format) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export const unzipEntry = entry => entry.method === 8 ? inflate(entry.data, "deflate-raw") : entry.data

export async function readWorldZip(buf) {
  const lib = await loadLibrary()
  const files = lib.parseZip(new Uint8Array(buf))
  // the world may sit at the zip root or nested one folder down; prefer the
  // overworld's region folder over DIM-1/DIM1
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

  // chunk presence straight from the 8KB region headers, no chunk decoding
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

  // structure-block saves live in generated/<ns>/structures: list them under
  // the world's own tree root, keeping any custom namespace
  const structures = new Map()
  for (const [p, entry] of files) {
    const m = p.match(/^(.*?)generated\/([^/]+)\/structures\/(.+)\.nbt$/)
    if (!m || m[1] !== prefix) continue
    structures.set("world/" + (m[2] === "minecraft" ? "" : m[2] + "/") + m[3], entry)
  }
  return { name, regionBufs, chunks, structures }
}

function scanRegion(bytes, rx, rz, key, chunks) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < 1024; i++) {
    if (dv.getUint32(i * 4) === 0) continue
    chunks.push({ cx: rx * 32 + (i & 31), cz: rz * 32 + (i >> 5), region: key, index: i })
  }
}

// a bare region file: coordinates come from the r.X.Z.mca name when present
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

// block entity nbt reaches the modal's JSON dump: BigInts and typed arrays
// don't survive that, so flatten to plain data
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
  // the vertical span only covers sections that hold any non-air blocks and
  // survive the y cutoffs
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

  // block entities first, so blocks can pick their nbt up in one pass
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
