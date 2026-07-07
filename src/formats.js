import { readNBT } from "./nbt.js"
import { AIR, parseState } from "./transforms.js"

// Readers for third-party structure formats, each returning the same
// { size, palette, blocks } shape as readStructure. Litematica and Sponge
// carry Java blockstates directly; Bedrock .mcstructure gets a best-effort
// state translation (common properties only; unmapped states are dropped).

function collector() {
  const palette = [], idx = new Map(), cells = []
  const stateFor = (Name, Properties) => {
    const key = Name + "|" + JSON.stringify(Properties ?? null)
    let i = idx.get(key)
    if (i === undefined) {
      i = palette.length
      palette.push(Properties ? { Name, Properties } : { Name })
      idx.set(key, i)
    }
    return i
  }
  const push = (x, y, z, state) => cells.push([x, y, z, state])
  // shift to a non-negative grid and derive the size from what's actually there
  const finish = () => {
    if (!cells.length) return { size: [1, 1, 1], palette: [{ Name: "minecraft:air" }], blocks: [{ state: 0, pos: [0, 0, 0] }] }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const c of cells) for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], c[i])
      hi[i] = Math.max(hi[i], c[i])
    }
    return {
      size: [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1],
      palette,
      blocks: cells.map(c => ({ state: c[3], pos: [c[0] - lo[0], c[1] - lo[1], c[2] - lo[2]] }))
    }
  }
  return { stateFor, push, finish }
}

const strProps = props => {
  if (!props) return undefined
  const out = {}
  for (const [k, v] of Object.entries(props)) out[k] = String(v)
  return Object.keys(out).length ? out : undefined
}

// ---- Litematica (.litematic): gzipped NBT, one or more regions of
// bit-packed palette indices. entries span long boundaries (pre-1.16 style),
// LSB first; index order is y, then z, then x fastest. negative Size means
// the region extends in the negative direction from Position.
export async function readLitematic(buf) {
  const root = await readNBT(buf)
  const { stateFor, push, finish } = collector()
  for (const region of Object.values(root.Regions ?? {})) {
    const size = region.Size, pos = region.Position
    const sx = Math.abs(size.x), sy = Math.abs(size.y), sz = Math.abs(size.z)
    const mx = pos.x + Math.min(size.x + 1, 0), my = pos.y + Math.min(size.y + 1, 0), mz = pos.z + Math.min(size.z + 1, 0)
    const pal = region.BlockStatePalette ?? []
    const states = region.BlockStates ?? []
    const bits = Math.max(2, 32 - Math.clz32(Math.max(1, pal.length - 1)))
    const mask = (1n << BigInt(bits)) - 1n
    const mapped = pal.map(e => AIR.test(e?.Name || "") ? -1 : stateFor(e.Name, strProps(e.Properties)))
    const vol = sx * sy * sz
    for (let n = 0; n < vol; n++) {
      const bit = n * bits, li = Math.floor(bit / 64), off = BigInt(bit % 64)
      let v = BigInt.asUintN(64, states[li]) >> off
      if (Number(off) + bits > 64) v |= BigInt.asUintN(64, states[li + 1]) << (64n - off)
      const state = mapped[Number(v & mask)]
      if (state === undefined || state < 0) continue
      const x = n % sx, z = Math.floor(n / sx) % sz, y = Math.floor(n / (sx * sz))
      push(mx + x, my + y, mz + z, state)
    }
  }
  return finish()
}

// ---- Sponge schematic (.schem, WorldEdit): gzipped NBT. v2 is flat with
// Palette { "state string": id } + varint BlockData; v3 nests them under
// Schematic.Blocks. index order is y, then z, then x fastest.
export async function readSchem(buf) {
  const root = await readNBT(buf)
  const s = root.Schematic ?? root
  const blocks = s.Blocks ?? s
  const paletteTag = blocks.Palette ?? {}
  const data = blocks.Data ?? blocks.BlockData
  const W = Number(s.Width), H = Number(s.Height), L = Number(s.Length)
  if (!data || !W || !H || !L) throw new Error("not a Sponge schematic")
  const { stateFor, push, finish } = collector()
  const byId = []
  for (const [str, id] of Object.entries(paletteTag)) {
    const e = parseState(str)
    byId[Number(id)] = AIR.test(e.Name) ? -1 : stateFor(e.Name, e.Properties)
  }
  let o = 0
  for (let i = 0; i < W * H * L; i++) {
    let v = 0, shift = 0, b
    do { b = data[o++]; v |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
    const state = byId[v]
    if (state === undefined || state < 0) continue
    const x = i % W, z = Math.floor(i / W) % L, y = Math.floor(i / (W * L))
    push(x, y, z, state)
  }
  return finish()
}

// ---- Bedrock (.mcstructure): LITTLE-endian NBT. two block layers (the
// second is mostly waterlogging), palette of { name, states }, index order
// x, then y, then z fastest. -1 = not saved.
const FACING6 = ["down", "up", "north", "south", "west", "east"]
const STAIRS4 = ["east", "west", "south", "north"]
const DIR4 = ["south", "west", "north", "east"]

function bedrockProps(states) {
  const p = {}
  for (const [k, v] of Object.entries(states ?? {})) {
    switch (k) {
      case "pillar_axis": p.axis = String(v); break
      case "minecraft:cardinal_direction": p.facing = String(v); break
      case "minecraft:facing_direction": p.facing = String(v); break
      case "facing_direction": if (FACING6[v]) p.facing = FACING6[v]; break
      case "weirdo_direction": if (STAIRS4[v]) p.facing = STAIRS4[v]; break
      case "direction": if (DIR4[v]) p.facing = DIR4[v]; break
      case "minecraft:vertical_half": p.type = String(v); break
      case "top_slot_bit": p.type = v ? "top" : "bottom"; break
      case "upside_down_bit": p.half = v ? "top" : "bottom"; break
      case "half": p.half = String(v); break
      case "open_bit": p.open = v ? "true" : "false"; break
      case "door_hinge_bit": p.hinge = v ? "right" : "left"; break
      case "upper_block_bit": p.half = v ? "upper" : "lower"; break
      case "ground_sign_direction": p.rotation = String(v); break
      case "hanging": p.hanging = v ? "true" : "false"; break
      case "lit": case "extinguished": p.lit = v ? "true" : "false"; break
      case "persistent_bit": p.persistent = v ? "true" : "false"; break
      case "candles": p.candles = String(Number(v) + 1); break
      case "growth": case "age": p.age = String(v); break
    }
  }
  return Object.keys(p).length ? p : undefined
}

export async function readMcstructure(buf) {
  const root = await readNBT(buf, { littleEndian: true })
  const [sx, sy, sz] = (root.size ?? []).map(Number)
  const layers = root.structure?.block_indices ?? []
  const pal = root.structure?.palette?.default?.block_palette ?? []
  if (!sx || !layers.length) throw new Error("not a .mcstructure file")
  const { stateFor, push, finish } = collector()
  const layer0 = layers[0], layer1 = layers[1]
  const water = new Set(pal.map((e, i) => /(^|:)(water|flowing_water)$/.test(e?.name || "") ? i : -1))
  for (let x = 0; x < sx; x++) for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) {
    const i = (x * sy + y) * sz + z
    const pi = Number(layer0[i])
    if (pi < 0) continue
    const e = pal[pi]
    if (!e?.name || AIR.test(e.name)) continue
    let props = bedrockProps(e.states)
    if (layer1 && water.has(Number(layer1[i]))) props = { ...props, waterlogged: "true" }
    push(x, y, z, stateFor(e.name, props))
  }
  return finish()
}
