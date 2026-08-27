const AIR = /(^|:)(air|cave_air|void_air|structure_void)$/

export const json = v => JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() + "n" : x)

function sideCounts(s) {
  const blocks = new Map()
  for (const b of s?.blocks ?? []) {
    const e = s.palette[b.state]
    if (!e?.id || AIR.test(e.id)) continue
    blocks.set(e.id, (blocks.get(e.id) ?? 0) + 1)
  }
  const entities = new Map()
  for (const e of s?.entities ?? []) {
    const id = e.nbt?.id
    if (typeof id !== "string") continue
    entities.set(id, (entities.get(id) ?? 0) + 1)
  }
  return { blocks, entities }
}

function mergeCounts(a, b) {
  const ids = new Set(a.keys())
  for (const id of b.keys()) ids.add(id)
  const rows = Array.from(ids, id => {
    const left = a.get(id) ?? 0, right = b.get(id) ?? 0
    return { id, left, right, delta: right - left, count: Math.abs(right - left) }
  })
  return rows.filter(r => r.delta !== 0)
}

function diffProps(a, b) {
  const keys = new Set(Object.keys(a ?? {}))
  for (const k of Object.keys(b ?? {})) keys.add(k)
  const out = []
  for (const k of Array.from(keys).sort()) {
    if (a?.[k] !== b?.[k]) out.push({ k, l: a?.[k] ?? "unset", r: b?.[k] ?? "unset" })
  }
  return out
}

const stripNs = id => id.replace(/^minecraft:/, "")

function pairChanges(leftStruct, rightStruct) {
  const leftAt = new Map()
  for (const b of leftStruct?.blocks ?? []) {
    const e = leftStruct.palette[b.state]
    if (!e?.id || AIR.test(e.id)) continue
    leftAt.set(b.pos.join(","), { entry: e, block: b })
  }
  const blocks = new Map()
  for (const b of rightStruct?.blocks ?? []) {
    const e = rightStruct.palette[b.state]
    if (!e?.id || AIR.test(e.id)) continue
    const l = leftAt.get(b.pos.join(","))
    if (!l || l.entry.id !== e.id) continue
    const props = diffProps(l.entry.properties, e.properties)
    const nbt = json(l.block.nbt ?? null) !== json(b.nbt ?? null)
    if (!props.length && !nbt) continue
    let g = blocks.get(e.id)
    if (!blocks.has(e.id)) blocks.set(e.id, g = { id: e.id, pairs: [] })
    g.pairs.push({ left: { ...l.block, entry: l.entry }, right: { ...b, entry: e }, props, nbt })
  }
  const leftEnt = new Map()
  for (const e of leftStruct?.entities ?? []) {
    if (typeof e.nbt?.id === "string") leftEnt.set(e.nbt.id + "|" + e.pos.join(","), e)
  }
  const entities = new Map()
  for (const e of rightStruct?.entities ?? []) {
    if (typeof e.nbt?.id !== "string") continue
    const l = leftEnt.get(e.nbt.id + "|" + e.pos.join(","))
    if (!l || json(l.nbt) === json(e.nbt)) continue
    let g = entities.get(e.nbt.id)
    if (!entities.has(e.nbt.id)) entities.set(e.nbt.id, g = { id: e.nbt.id, pairs: [] })
    g.pairs.push({ left: l, right: e, props: [], nbt: true })
  }
  const order = m => Array.from(m.values()).sort((a, b) => b.pairs.length - a.pairs.length || stripNs(a.id).localeCompare(stripNs(b.id)))
  return { blocks: order(blocks), entities: order(entities) }
}

export function compareChanges(leftStruct, rightStruct) {
  const left = sideCounts(leftStruct)
  const right = sideCounts(rightStruct)
  return {
    blocks: mergeCounts(left.blocks, right.blocks),
    entities: mergeCounts(left.entities, right.entities),
    changed: pairChanges(leftStruct, rightStruct)
  }
}
