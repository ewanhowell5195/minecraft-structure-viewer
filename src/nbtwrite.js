const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
}

const te = new TextEncoder()

// the reader hands back plain js values, so nested block entity and entity nbt
// is typed by inference; these keys are the ones the game is strict about
const INT_ARRAY_KEYS = new Set(["UUID"])
const FLOAT_LIST_KEYS = new Set(["Rotation"])
const DOUBLE_LIST_KEYS = new Set(["Pos", "Motion"])
const FLOAT_KEYS = new Set(["FallDistance", "fall_distance", "Health"])

class Buf {
  constructor() {
    this.chunks = []
    this.len = 0
  }
  push(bytes) {
    this.chunks.push(bytes)
    this.len += bytes.length
  }
  num(size, set, v) {
    const b = new Uint8Array(size)
    set(new DataView(b.buffer), v)
    this.push(b)
  }
  u8(v) { this.num(1, (d, x) => d.setUint8(0, x), v) }
  i16(v) { this.num(2, (d, x) => d.setInt16(0, x), v) }
  i32(v) { this.num(4, (d, x) => d.setInt32(0, x), v) }
  i64(v) { this.num(8, (d, x) => d.setBigInt64(0, BigInt(x)), v) }
  f32(v) { this.num(4, (d, x) => d.setFloat32(0, x), v) }
  f64(v) { this.num(8, (d, x) => d.setFloat64(0, x), v) }
  str(s) {
    const e = te.encode(String(s))
    this.i16(e.length)
    this.push(e)
  }
  bytes() {
    const out = new Uint8Array(this.len)
    let o = 0
    for (const c of this.chunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  }
}

const isInt = v => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647

function tagOf(v, key) {
  if (typeof v === "boolean") return TAG.BYTE
  if (typeof v === "bigint") return TAG.LONG
  if (typeof v === "number") return FLOAT_KEYS.has(key) ? TAG.FLOAT : isInt(v) ? TAG.INT : TAG.DOUBLE
  if (typeof v === "string") return TAG.STRING
  if (v instanceof Uint8Array || v instanceof Int8Array) return TAG.BYTE_ARRAY
  // the reader splits long arrays into lo/hi uint32 pairs
  if (v instanceof Uint32Array) return TAG.LONG_ARRAY
  if (Array.isArray(v)) return INT_ARRAY_KEYS.has(key) ? TAG.INT_ARRAY : TAG.LIST
  if (v && typeof v === "object") return TAG.COMPOUND
  return TAG.END
}

function writePayload(buf, tag, v, key) {
  switch (tag) {
    case TAG.BYTE: return buf.u8(v === true ? 1 : v === false ? 0 : v & 0xFF)
    case TAG.SHORT: return buf.i16(v)
    case TAG.INT: return buf.i32(v)
    case TAG.LONG: return buf.i64(v)
    case TAG.FLOAT: return buf.f32(v)
    case TAG.DOUBLE: return buf.f64(v)
    case TAG.STRING: return buf.str(v)
    case TAG.BYTE_ARRAY:
      buf.i32(v.length)
      return buf.push(new Uint8Array(v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v))
    case TAG.INT_ARRAY:
      buf.i32(v.length)
      for (const n of v) buf.i32(n)
      return
    case TAG.LONG_ARRAY:
      buf.i32(v.length / 2)
      for (let i = 0; i < v.length; i += 2) {
        buf.i32(v[i + 1] | 0)
        buf.i32(v[i] | 0)
      }
      return
    case TAG.LIST: {
      const elem = listElemTag(v, key)
      buf.u8(elem)
      buf.i32(v.length)
      for (const item of v) writePayload(buf, elem, item, key)
      return
    }
    case TAG.COMPOUND: {
      for (const k of Object.keys(v)) {
        const t = tagOf(v[k], k)
        if (t === TAG.END) continue
        buf.u8(t)
        buf.str(k)
        writePayload(buf, t, v[k], k)
      }
      return buf.u8(TAG.END)
    }
  }
}

function listElemTag(list, key) {
  if (!list.length) return TAG.END
  if (FLOAT_LIST_KEYS.has(key)) return TAG.FLOAT
  if (DOUBLE_LIST_KEYS.has(key)) return TAG.DOUBLE
  const tags = new Set(list.map(v => tagOf(v, null)))
  if (tags.size === 1) return tags.values().next().value
  // a mixed numeric list has to widen, or the narrow entries lose their value
  if (tags.has(TAG.DOUBLE) && tags.has(TAG.INT)) return TAG.DOUBLE
  return tags.values().next().value
}

function intList(buf, name, values) {
  buf.u8(TAG.LIST)
  buf.str(name)
  buf.u8(TAG.INT)
  buf.i32(values.length)
  for (const n of values) buf.i32(Math.round(n))
}

function doubleList(buf, name, values) {
  buf.u8(TAG.LIST)
  buf.str(name)
  buf.u8(TAG.DOUBLE)
  buf.i32(values.length)
  for (const n of values) buf.f64(n)
}

// the vanilla .nbt structure format, as the structure block saves it
export function writeStructure(structure, dataVersion) {
  const buf = new Buf()
  buf.u8(TAG.COMPOUND)
  buf.str("")

  if (dataVersion != null) {
    buf.u8(TAG.INT)
    buf.str("DataVersion")
    buf.i32(dataVersion)
  }

  intList(buf, "size", structure.size ?? [0, 0, 0])

  buf.u8(TAG.LIST)
  buf.str("palette")
  buf.u8(TAG.COMPOUND)
  const palette = structure.palette ?? []
  buf.i32(palette.length)
  for (const e of palette) {
    buf.u8(TAG.STRING)
    buf.str("Name")
    buf.str(e?.id ?? "minecraft:air")
    const props = e?.properties
    if (props && Object.keys(props).length) {
      buf.u8(TAG.COMPOUND)
      buf.str("Properties")
      for (const [k, v] of Object.entries(props)) {
        buf.u8(TAG.STRING)
        buf.str(k)
        buf.str(v)
      }
      buf.u8(TAG.END)
    }
    buf.u8(TAG.END)
  }

  buf.u8(TAG.LIST)
  buf.str("blocks")
  buf.u8(TAG.COMPOUND)
  const blocks = structure.blocks ?? []
  buf.i32(blocks.length)
  for (const b of blocks) {
    buf.u8(TAG.INT)
    buf.str("state")
    buf.i32(b.state ?? 0)
    intList(buf, "pos", b.pos ?? [0, 0, 0])
    if (b.nbt && typeof b.nbt === "object") {
      buf.u8(TAG.COMPOUND)
      buf.str("nbt")
      writePayload(buf, TAG.COMPOUND, b.nbt, "nbt")
    }
    buf.u8(TAG.END)
  }

  buf.u8(TAG.LIST)
  buf.str("entities")
  buf.u8(TAG.COMPOUND)
  const entities = structure.entities ?? []
  buf.i32(entities.length)
  for (const e of entities) {
    const pos = e.pos ?? [0, 0, 0]
    doubleList(buf, "pos", pos)
    intList(buf, "blockPos", pos.map(Math.floor))
    if (e.nbt && typeof e.nbt === "object") {
      buf.u8(TAG.COMPOUND)
      buf.str("nbt")
      writePayload(buf, TAG.COMPOUND, e.nbt, "nbt")
    }
    buf.u8(TAG.END)
  }

  buf.u8(TAG.END)
  return buf.bytes()
}

export async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
