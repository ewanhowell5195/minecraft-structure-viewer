const CRC = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") return null
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

export async function makeZip(files) {
  const encoder = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    const packed = await deflate(file.data)
    const deflated = packed && packed.length < file.data.length
    const body = deflated ? packed : file.data
    const head = new DataView(new ArrayBuffer(30))
    head.setUint32(0, 0x04034B50, true)
    head.setUint16(4, 20, true)
    head.setUint16(8, deflated ? 8 : 0, true)
    head.setUint32(14, crc32(file.data), true)
    head.setUint32(18, body.length, true)
    head.setUint32(22, file.data.length, true)
    head.setUint16(26, name.length, true)
    parts.push(new Uint8Array(head.buffer), name, body)

    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014B50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(10, deflated ? 8 : 0, true)
    entry.setUint32(16, crc32(file.data), true)
    entry.setUint32(20, body.length, true)
    entry.setUint32(24, file.data.length, true)
    entry.setUint16(28, name.length, true)
    entry.setUint32(42, offset, true)
    central.push(new Uint8Array(entry.buffer), name)
    offset += 30 + name.length + body.length
  }

  const size = central.reduce((n, part) => n + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054B50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" })
}
