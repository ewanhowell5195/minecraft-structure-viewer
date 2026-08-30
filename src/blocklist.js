export function attachBlocks(s, raw, blockNbt) {
  Object.defineProperty(s, "raw", { value: raw, enumerable: false, configurable: true })
  Object.defineProperty(s, "blockNbt", { value: blockNbt, enumerable: false, configurable: true })
  let cache
  Object.defineProperty(s, "blocks", {
    enumerable: true,
    configurable: true,
    get() {
      if (cache) return cache
      cache = new Array(raw.length >> 2)
      for (let i = 0, j = 0; j < cache.length; i += 4, j++) {
        cache[j] = { state: raw[i], pos: [raw[i + 1], raw[i + 2], raw[i + 3]] }
      }
      for (const [i, nbt] of blockNbt) if (cache[i]) cache[i].nbt = nbt
      return cache
    }
  })
  return s
}

export function ensureRaw(s) {
  if (!s || s.raw) return s
  const blocks = s.blocks ?? []
  const raw = new Int32Array(blocks.length * 4)
  const nbt = new Map()
  for (let i = 0, j = 0; i < blocks.length; i++) {
    const b = blocks[i]
    raw[j++] = b.state
    raw[j++] = b.pos[0]
    raw[j++] = b.pos[1]
    raw[j++] = b.pos[2]
    if (b.nbt) nbt.set(i, b.nbt)
  }
  Object.defineProperty(s, "raw", { value: raw, enumerable: false, configurable: true })
  Object.defineProperty(s, "blockNbt", { value: nbt, enumerable: false, configurable: true })
  return s
}

// `blocks` is an accessor, so a spread would materialize it
export function derive(s, raw, blockNbt, extra) {
  const out = {}
  for (const k of Object.keys(s)) if (k !== "blocks") out[k] = s[k]
  out.blocks = null
  if (extra) Object.assign(out, extra)
  return attachBlocks(out, raw, blockNbt)
}

export const blockCount = s => s.raw ? s.raw.length >> 2 : s.blocks.length

export function blockAt(s, i) {
  const raw = s.raw
  if (!raw) return s.blocks[i]
  const j = i << 2
  const b = { state: raw[j], pos: [raw[j + 1], raw[j + 2], raw[j + 3]] }
  const nbt = s.blockNbt.get(i)
  if (nbt) b.nbt = nbt
  return b
}

export class RawBuilder {
  constructor(hint = 1024) {
    this.buf = new Int32Array(Math.max(4, hint * 4))
    this.n = 0
    this.nbt = new Map()
  }
  push(state, x, y, z, nbt) {
    if (this.n === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    if (nbt) this.nbt.set(this.n >> 2, nbt)
    this.buf[this.n++] = state
    this.buf[this.n++] = x
    this.buf[this.n++] = y
    this.buf[this.n++] = z
  }
  get count() { return this.n >> 2 }
  // a subarray keeps the whole buffer alive
  finish() { return this.n * 2 < this.buf.length ? this.buf.slice(0, this.n) : this.buf.subarray(0, this.n) }
}
