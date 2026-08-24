import { REAL_AIR } from "./transforms.js"

// what a structure holds per cell, as comparable strings: the block's state and
// nbt, plus the entities standing there. canonical ordering throughout, so two
// serialisations of the same data always read equal

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

export function cellContents(structure) {
  const map = new Map()
  for (const b of structure.blocks ?? []) {
    const e = structure.palette?.[b.state]
    if (!e?.Name || REAL_AIR.test(e.Name)) continue
    const props = Object.keys(e.Properties ?? {}).sort().map(k => k + "=" + e.Properties[k]).join(",")
    map.set(key3(b.pos), e.Name + "[" + props + "]" + (b.nbt ? "#" + canon(b.nbt) : ""))
  }
  const ents = new Map()
  for (const ent of structure.entities ?? []) {
    const k = key3(ent.pos.map(Math.floor))
    if (!ents.has(k)) ents.set(k, [])
    ents.get(k).push(canon({ nbt: ent.nbt ?? null, pos: ent.pos }))
  }
  for (const [k, list] of ents) {
    map.set(k, (map.get(k) ?? "") + "+" + list.sort().join("+"))
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
