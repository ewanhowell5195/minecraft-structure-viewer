import { REAL_AIR } from "./transforms.js"

// a structure's contents per cell, canonically ordered, so two serialisations
// of the same data always read equal

function canon(v) {
  if (typeof v === "bigint") return '"' + v + '"'
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]"
  if (v && typeof v === "object" && !ArrayBuffer.isView(v)) {
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  }
  if (ArrayBuffer.isView(v)) return "[" + Array.from(v).join(",") + "]"
  return JSON.stringify(v) ?? "null"
}

const key3 = p => p[0] + "," + p[1] + "," + p[2]

// positions are feet-level, so the cell an entity is mostly inside sits half a
// block up
const entCell = pos => Math.floor(pos[0]) + "," + Math.floor(pos[1] + 0.5) + "," + Math.floor(pos[2])

export function cellContents(structure) {
  const map = new Map()
  for (const b of structure.blocks ?? []) {
    const e = structure.palette?.[b.state]
    if (!e?.id || REAL_AIR.test(e.id)) continue
    const props = Object.keys(e.properties ?? {}).sort().map(k => k + "=" + e.properties[k]).join(",")
    map.set(key3(b.pos), e.id + "[" + props + "]" + (b.nbt ? "#" + canon(b.nbt) : ""))
  }
  const ents = new Map()
  for (const ent of structure.entities ?? []) {
    const k = entCell(ent.pos)
    if (!ents.has(k)) ents.set(k, [])
    ents.get(k).push(canon({ nbt: ent.nbt ?? null, pos: ent.pos }))
  }
  for (const [k, list] of ents) {
    map.set(k, (map.get(k) ?? "") + "+" + list.sort().join("+"))
  }
  return map
}

// per-cell items rather than one packed string, so diffs can count blocks and
// entities individually; entities key by id + exact position
export function cellItems(structure) {
  const map = new Map()
  const cell = k => {
    let c = map.get(k)
    if (!c) map.set(k, c = { block: null, ents: new Map() })
    return c
  }
  for (const b of structure.blocks ?? []) {
    const e = structure.palette?.[b.state]
    if (!e?.id || REAL_AIR.test(e.id)) continue
    const props = Object.keys(e.properties ?? {}).sort().map(k => k + "=" + e.properties[k]).join(",")
    cell(key3(b.pos)).block = e.id + "[" + props + "]" + (b.nbt ? "#" + canon(b.nbt) : "")
  }
  for (const ent of structure.entities ?? []) {
    const id = ent.nbt?.id ?? ""
    cell(entCell(ent.pos)).ents.set(id + "|" + ent.pos.join(","), canon({ nbt: ent.nbt ?? null, pos: ent.pos }))
  }
  return map
}

export function sameStructure(a, b) {
  if ((a.size ?? []).join(",") !== (b.size ?? []).join(",")) return false
  const ca = cellContents(a), cb = cellContents(b)
  if (ca.size !== cb.size) return false
  for (const [k, v] of ca) if (cb.get(k) !== v) return false
  return true
}
