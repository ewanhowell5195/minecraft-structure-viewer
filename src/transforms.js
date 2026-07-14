// rotation = k clockwise 90deg steps about +Y with pivot ZERO, matching StructureTemplate.transform

export const DIR = {
  north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
  up: [0, 1, 0], down: [0, -1, 0]
}
export const HORIZ = ["north", "east", "south", "west"] // clockwise looking down
export const OPP = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" }

export function rotDir(d, k) {
  const i = HORIZ.indexOf(d)
  return i < 0 ? d : HORIZ[(i + k) & 3]
}

export function rotPos([x, y, z], k) {
  switch (k & 3) {
    case 1: return [-z, y, x]
    case 2: return [-x, y, -z]
    case 3: return [z, y, -x]
    default: return [x, y, z]
  }
}

export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

// mulberry32
export function rnd(seed) {
  let s = seed | 0
  return () => {
    let t = s = (s + 0x6D2B79F5) | 0
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

export function shuffle(arr, rand) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export const rand32 = () => (Math.random() * 0x100000000) >>> 0

export const numeric = new Intl.Collator("en", { numeric: true }).compare

export function statePicker() {
  const palette = [], palIdx = new Map()
  const stateFor = (Name, Properties) => {
    const pk = Name + "|" + JSON.stringify(Properties ?? null)
    let i = palIdx.get(pk)
    if (i === undefined) {
      i = palette.length
      palette.push(Properties ? { Name, Properties } : { Name })
      palIdx.set(pk, i)
    }
    return i
  }
  return { palette, stateFor }
}

export function mix(a, b) {
  let h = Math.imul(a ^ Math.imul(b + 1, 0x9E3779B1), 0x85EBCA6B)
  h ^= h >>> 13
  return h >>> 0
}

export const strip = s => s.replace(/^minecraft:/, "")

export function parseState(str) {
  const m = typeof str === "string" && str.trim().match(/^([\w./-]+(?::[\w./-]+)?)(?:\[(.*)\])?$/)
  if (!m) return { Name: "minecraft:air" }
  const Name = m[1].includes(":") ? m[1] : "minecraft:" + m[1]
  if (!m[2]) return { Name }
  const Properties = {}
  for (const kv of m[2].split(",")) {
    const [k, v] = kv.split("=")
    if (k && v !== undefined) Properties[k.trim()] = v.trim()
  }
  return { Name, Properties }
}

const SIDES = ["north", "east", "south", "west"]

export function rotateState(props, k) {
  if (!props || !(k & 3)) return props
  const p = { ...props }
  if (p.facing && DIR[p.facing]) p.facing = rotDir(p.facing, k)
  if (p.orientation) { // jigsaw blocks: "<front>_<top>"
    const i = p.orientation.lastIndexOf("_")
    if (i > 0) p.orientation = rotDir(p.orientation.slice(0, i), k) + "_" + rotDir(p.orientation.slice(i + 1), k)
  }
  if (k & 1) {
    if (p.axis === "x") p.axis = "z"
    else if (p.axis === "z") p.axis = "x"
  }
  if (p.rotation !== undefined) p.rotation = String((parseInt(p.rotation) + 4 * k) & 15)
  // read all old connection values first so chained remaps don't clobber
  const conn = SIDES.filter(s => s in props)
  if (conn.length) {
    for (const s of conn) delete p[s]
    for (const s of conn) p[rotDir(s, k)] = props[s]
  }
  return p
}

// MC applies mirror BEFORE rotation; "lr" (LEFT_RIGHT) flips Z, "fb" (FRONT_BACK) flips X
export function mirrorPos([x, y, z], mir) {
  if (mir === "lr") return [x, y, -z]
  if (mir === "fb") return [-x, y, z]
  return [x, y, z]
}

export function mirrorDir(d, mir) {
  if (mir === "lr") return d === "north" ? "south" : d === "south" ? "north" : d
  if (mir === "fb") return d === "east" ? "west" : d === "west" ? "east" : d
  return d
}

export function mirrorState(props, mir) {
  if (!props || !mir) return props
  const p = { ...props }
  if (p.facing && DIR[p.facing]) p.facing = mirrorDir(p.facing, mir)
  if (p.orientation) {
    const i = p.orientation.lastIndexOf("_")
    if (i > 0) p.orientation = mirrorDir(p.orientation.slice(0, i), mir) + "_" + mirrorDir(p.orientation.slice(i + 1), mir)
  }
  if (p.shape && /left|right/.test(p.shape)) {
    const fAxis = props.facing === "north" || props.facing === "south" ? "z"
      : props.facing === "east" || props.facing === "west" ? "x" : null
    if (fAxis === (mir === "lr" ? "z" : "x")) {
      p.shape = p.shape.includes("left") ? p.shape.replace("left", "right") : p.shape.replace("right", "left")
    }
  }
  if (p.hinge) p.hinge = p.hinge === "left" ? "right" : "left"
  if (p.rotation !== undefined) {
    const r = parseInt(p.rotation)
    const c = r > 8 ? r - 16 : r
    p.rotation = String(mir === "lr" ? (8 - c + 16) % 16 : (16 - c) % 16)
  }
  const [a, b] = mir === "lr" ? ["north", "south"] : ["east", "west"]
  const hasA = a in props, hasB = b in props
  if (hasA || hasB) {
    delete p[a]
    delete p[b]
    if (hasA) p[b] = props[a]
    if (hasB) p[a] = props[b]
  }
  return p
}

export const AIR = /(^|:)(air|cave_air|void_air|structure_void)$/
export const STRUCT_VOID = /(^|:)structure_void$/
export const REAL_AIR = /(^|:)(air|cave_air|void_air)$/
export const JIGSAW = /(^|:)jigsaw$/

export function jigsawsOf(struct) {
  const out = []
  for (const b of struct.blocks) {
    const e = struct.palette[b.state]
    if (!JIGSAW.test(e?.Name || "")) continue
    const or = e.Properties?.orientation || "north_up"
    const i = or.lastIndexOf("_")
    const n = b.nbt ?? {}
    out.push({
      pos: b.pos,
      front: or.slice(0, i),
      top: or.slice(i + 1),
      pool: typeof n.pool === "string" ? n.pool : "",
      name: typeof n.name === "string" ? n.name : "",
      target: typeof n.target === "string" ? n.target : "",
      joint: n.joint === "aligned" ? "aligned" : "rollable"
    })
  }
  return out
}

export function worldJigsaw(j, piece) {
  const p = rotPos(j.pos, piece.rot)
  return {
    ...j,
    pos: [p[0] + piece.off[0], p[1] + piece.off[1], p[2] + piece.off[2]],
    front: rotDir(j.front, piece.rot),
    top: rotDir(j.top, piece.rot)
  }
}

export function pieceBox(struct, k, off) {
  const [sx, sy, sz] = struct.size
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const x of [0, sx - 1]) for (const y of [0, sy - 1]) for (const z of [0, sz - 1]) {
    const p = rotPos([x, y, z], k)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i])
      hi[i] = Math.max(hi[i], p[i])
    }
  }
  return {
    x0: lo[0] + off[0], y0: lo[1] + off[1], z0: lo[2] + off[2],
    x1: hi[0] + off[0] + 1, y1: hi[1] + off[1] + 1, z1: hi[2] + off[2] + 1
  }
}

// vanilla: overlap must exceed 0.25 on every axis, so abutting faces don't count as a hit
export const boxHit = (a, b) =>
  Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.25 &&
  Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.25 &&
  Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 0.25

export const inBox = (p, b) =>
  p[0] >= b.x0 && p[0] < b.x1 && p[1] >= b.y0 && p[1] < b.y1 && p[2] >= b.z0 && p[2] < b.z1

export const EMPTY = Symbol("empty_pool_element")

// list_pool_element approximated by its first entry
export function poolTemplates(pool) {
  const out = []
  for (const e of pool?.elements ?? []) {
    const el = e.element ?? {}
    const w = Math.max(1, typeof e.weight === "number" ? e.weight : 1)
    const type = (el.element_type ?? "").replace("minecraft:", "")
    let loc = null
    if (type === "empty_pool_element") loc = EMPTY
    else if (type === "list_pool_element") loc = el.elements?.[0]?.location
    else loc = el.location
    if (loc !== EMPTY && typeof loc !== "string") continue
    if (typeof loc === "string") loc = strip(loc)
    for (let i = 0; i < w; i++) out.push(loc)
  }
  return out
}
