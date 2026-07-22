const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
}

const td = new TextDecoder()

export async function readNBT(input, { littleEndian = false, skip } = {}) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
    bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const le = littleEndian
  let o = 0

  function string() {
    const len = dv.getUint16(o, le); o += 2
    const s = td.decode(bytes.subarray(o, o + len)); o += len
    return s
  }

  function skipPayload(type) {
    switch (type) {
      case TAG.BYTE: o += 1; return
      case TAG.SHORT: o += 2; return
      case TAG.INT: case TAG.FLOAT: o += 4; return
      case TAG.LONG: case TAG.DOUBLE: o += 8; return
      case TAG.BYTE_ARRAY: { const len = dv.getInt32(o, le); o += 4 + len; return }
      case TAG.STRING: { const len = dv.getUint16(o, le); o += 2 + len; return }
      case TAG.LIST: {
        const t = dv.getUint8(o); o += 1
        const len = dv.getInt32(o, le); o += 4
        for (let i = 0; i < len; i++) skipPayload(t)
        return
      }
      case TAG.COMPOUND: {
        for (;;) {
          const t = dv.getUint8(o); o += 1
          if (t === TAG.END) return
          const len = dv.getUint16(o, le); o += 2 + len
          skipPayload(t)
        }
      }
      case TAG.INT_ARRAY: { const len = dv.getInt32(o, le); o += 4 + len * 4; return }
      case TAG.LONG_ARRAY: { const len = dv.getInt32(o, le); o += 4 + len * 8; return }
      default: throw new Error(`Unknown NBT tag type ${type} at ${o}`)
    }
  }

  function payload(type) {
    switch (type) {
      case TAG.BYTE: { const v = dv.getInt8(o); o += 1; return v }
      case TAG.SHORT: { const v = dv.getInt16(o, le); o += 2; return v }
      case TAG.INT: { const v = dv.getInt32(o, le); o += 4; return v }
      case TAG.LONG: { const v = dv.getBigInt64(o, le); o += 8; return v }
      case TAG.FLOAT: { const v = dv.getFloat32(o, le); o += 4; return v }
      case TAG.DOUBLE: { const v = dv.getFloat64(o, le); o += 8; return v }
      case TAG.BYTE_ARRAY: { const len = dv.getInt32(o, le); o += 4; const a = bytes.slice(o, o + len); o += len; return a }
      case TAG.STRING: return string()
      case TAG.LIST: {
        const t = dv.getUint8(o); o += 1
        const len = dv.getInt32(o, le); o += 4
        const arr = new Array(len)
        for (let i = 0; i < len; i++) arr[i] = payload(t)
        return arr
      }
      case TAG.COMPOUND: {
        const obj = {}
        for (;;) {
          const t = dv.getUint8(o); o += 1
          if (t === TAG.END) break
          const name = string()
          if (skip !== undefined && skip.has(name)) skipPayload(t)
          else obj[name] = payload(t)
        }
        return obj
      }
      case TAG.INT_ARRAY: {
        const len = dv.getInt32(o, le); o += 4
        const a = new Array(len)
        for (let i = 0; i < len; i++) { a[i] = dv.getInt32(o, le); o += 4 }
        return a
      }
      // long arrays surface as Uint32Array [lo, hi] pairs so palette decoding
      // never touches BigInt
      case TAG.LONG_ARRAY: {
        const len = dv.getInt32(o, le); o += 4
        const a = new Uint32Array(len * 2)
        if (le) for (let i = 0; i < len; i++) { a[i * 2] = dv.getUint32(o, true); a[i * 2 + 1] = dv.getUint32(o + 4, true); o += 8 }
        else for (let i = 0; i < len; i++) { a[i * 2 + 1] = dv.getUint32(o, false); a[i * 2] = dv.getUint32(o + 4, false); o += 8 }
        return a
      }
      default: throw new Error(`Unknown NBT tag type ${type} at ${o}`)
    }
  }

  const rootType = dv.getUint8(o); o += 1
  if (rootType !== TAG.COMPOUND) throw new Error("NBT root is not a compound")
  string()
  return payload(TAG.COMPOUND)
}

// some vanilla files (shipwrecks) use the plural `palettes` form
export async function readStructure(input) {
  const root = await readNBT(input)
  const size = (root.size ?? [0, 0, 0]).map(Number)
  const palette = root.palette ?? root.palettes?.[0] ?? []
  const blocks = (root.blocks ?? []).map(b => ({
    state: Number(b.state),
    pos: b.pos.map(Number),
    nbt: b.nbt
  }))
  const entities = (root.entities ?? []).flatMap(e => e.nbt ? [{
    pos: (e.pos ?? e.blockPos ?? [0, 0, 0]).map(Number),
    nbt: e.nbt
  }] : [])
  return { size, palette, blocks, entities }
}
