import { shuffle, statePicker } from "./transforms.js"
import { sampleInt } from "./features/providers.js"

const strip = s => (s ?? "").replace("minecraft:", "")
const ns = n => n.includes(":") ? n : "minecraft:" + n
const nsify = ref => typeof ref === "string" ? ref.replace(":", "/") : null
const SKIP_OVERLAY = /(^|:)(air|cave_air|void_air|structure_void|jigsaw|structure_block)$/

export function seedFor(name) {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const POOL_RE = /^data\/([^/]+)\/worldgen\/template_pool\/.+\.json$/
const STRUCT_RE = /^data\/([^/]+)\/worldgen\/structure\/.+\.json$/

// template -> the processors and list-element overlays the game applies when
// placing it, from the template pools; zombie pools only claim a template no
// other pool wants. ruined portals aren't jigsaw: their block_age/blackstone
// come from the structure json's setups, applied to the whole template folder
export async function buildProcessorIndex(keys, readJson, rels) {
  const index = new Map()
  const resolveCache = new Map()
  const resolve = ref => {
    if (ref == null) return Promise.resolve([])
    if (typeof ref !== "string") return Promise.resolve(Array.isArray(ref) ? ref : ref.processors ?? [])
    if (!resolveCache.has(ref)) {
      const [pns, path] = ref.includes(":") ? ref.split(":") : ["minecraft", ref]
      resolveCache.set(ref, readJson(`data/${pns}/worldgen/processor_list/${path}.json`).then(j => j?.processors ?? []))
    }
    return resolveCache.get(ref)
  }
  const pools = keys.filter(k => POOL_RE.test(k)).sort((a, b) => /zombie/.test(a) - /zombie/.test(b))
  for (const p of pools) {
    const j = await readJson(p)
    for (const e of j?.elements ?? []) {
      const el = e?.element ?? {}
      const seq = strip(el.element_type ?? "").endsWith("list_pool_element") ? el.elements ?? [] : [el]
      const entries = []
      for (const item of seq) {
        const loc = nsify(item?.location)
        if (loc) entries.push({ loc, procs: await resolve(item.processors) })
      }
      if (!entries.length) continue
      const [base, ...overlays] = entries
      if (!base.procs.length && !overlays.length) continue
      if (!index.has(base.loc)) index.set(base.loc, { procs: base.procs, overlays })
    }
  }
  for (const k of keys.filter(k => STRUCT_RE.test(k)).sort()) {
    const j = await readJson(k)
    if (strip(j?.type ?? "") !== "ruined_portal" || !j.setups?.length) continue
    const sns = k.match(STRUCT_RE)[1]
    const setup = j.setups[0]
    const procs = [{ processor_type: "minecraft:block_age", mossiness: setup.mossiness ?? 0 }]
    if (setup.replace_with_blackstone) procs.push({ processor_type: "minecraft:blackstone_replace" })
    for (const rel of rels) {
      if (rel.startsWith(sns + "/ruined_portal/") && !index.has(rel)) index.set(rel, { procs, overlays: [] })
    }
  }
  await resolveTags(index, readJson)
  return index
}

// tag_match predicates and #tag rottables resolve against the block tag data
// files up front, so matching stays synchronous
async function resolveTags(index, readJson) {
  const cache = new Map()
  const tagSet = async ref => {
    const key = strip(ref).replace(/^#/, "")
    if (cache.has(key)) return cache.get(key)
    const out = new Set()
    cache.set(key, out)
    const [tns, path] = key.includes(":") ? key.split(":") : ["minecraft", key]
    const j = await readJson(`data/${tns}/tags/block/${path}.json`) ?? await readJson(`data/${tns}/tags/blocks/${path}.json`)
    for (const v of j?.values ?? []) {
      const id = typeof v === "string" ? v : v?.id
      if (typeof id !== "string") continue
      if (id.startsWith("#")) for (const n of await tagSet(id)) out.add(n)
      else out.add(ns(id))
    }
    return out
  }
  const walkProc = async proc => {
    const t = strip(proc?.processor_type ?? "")
    if (t === "capped") return walkProc(proc.delegate)
    if (t === "block_rot" && typeof proc.rottable_blocks === "string" && proc.rottable_blocks.includes("#")) {
      proc.__rotSet = await tagSet(proc.rottable_blocks)
    }
    if (t !== "rule") return
    for (const r of proc.rules ?? []) {
      const pred = r.input_predicate
      if (strip(pred?.predicate_type ?? "") === "tag_match" && typeof pred.tag === "string") {
        pred.__set = await tagSet(pred.tag)
      }
    }
  }
  for (const entry of index.values()) {
    for (const p of entry.procs) await walkProc(p)
    for (const ov of entry.overlays) for (const p of ov.procs) await walkProc(p)
  }
}

const REMOVED = Symbol("removed")

function stateEquals(e, s) {
  if (strip(e.Name) !== strip(s?.Name)) return false
  const a = e.Properties ?? {}
  return Object.entries(s?.Properties ?? {}).every(([k, v]) => String(a[k]) === String(v))
}

function matchInput(pred, e, rand) {
  switch (strip(pred?.predicate_type ?? "always_true")) {
    case "always_true": return true
    case "block_match": return strip(e.Name) === strip(pred.block)
    case "random_block_match": return strip(e.Name) === strip(pred.block) && rand() < (pred.probability ?? 1)
    case "blockstate_match": return stateEquals(e, pred.block_state)
    case "random_blockstate_match": return stateEquals(e, pred.block_state) && rand() < (pred.probability ?? 1)
    case "tag_match": return !!pred.__set?.has(ns(e.Name ?? ""))
    default: return false
  }
}

const alwaysTrue = pred => strip(pred?.predicate_type ?? "always_true") === "always_true"

function applyRule(proc, e, rand) {
  for (const r of proc.rules ?? []) {
    if (!matchInput(r.input_predicate, e, rand)) continue
    if (!alwaysTrue(r.location_predicate) || (r.position_predicate && !alwaysTrue(r.position_predicate))) continue
    const out = r.output_state ?? {}
    let nbt = e.nbt
    const mod = r.block_entity_modifier
    const mt = strip(mod?.type ?? "passthrough")
    if (mt === "clear") nbt = undefined
    else if (mt === "append_loot") nbt = { ...(nbt ?? {}), LootTable: mod.loot_table }
    else if (mt === "append_static") nbt = { ...(nbt ?? {}), ...(mod.data ?? {}) }
    if (r.output_nbt) nbt = r.output_nbt
    return { Name: out.Name ?? e.Name, Properties: out.Properties, nbt }
  }
  return null
}

const HORIZ = ["north", "south", "west", "east"]

function applyBlockAge(proc, e, rand) {
  const mossiness = proc.mossiness ?? 0
  const n = strip(e.Name)
  const stairs = base => ({ Name: ns(base), Properties: { facing: HORIZ[(rand() * 4) | 0], half: rand() < 0.5 ? "top" : "bottom" }, nbt: e.nbt })
  if (n === "stone_bricks" || n === "stone" || n === "chiseled_stone_bricks") {
    if (rand() >= 0.5) return null
    const mossy = rand() < mossiness
    if (rand() < 0.5) return { Name: ns(mossy ? "mossy_stone_bricks" : "cracked_stone_bricks"), nbt: e.nbt }
    return stairs(mossy ? "mossy_stone_brick_stairs" : "stone_brick_stairs")
  }
  if (n.endsWith("_stairs")) {
    if (rand() >= 0.5) return null
    if (rand() < mossiness) {
      if (rand() < 0.5) {
        const p = e.Properties ?? {}
        return { Name: ns("mossy_stone_brick_stairs"), Properties: { facing: p.facing ?? "north", half: p.half ?? "bottom" }, nbt: e.nbt }
      }
      return { Name: ns("mossy_stone_brick_slab"), nbt: e.nbt }
    }
    return { Name: ns(rand() < 0.5 ? "stone_slab" : "stone_brick_slab"), nbt: e.nbt }
  }
  if (n.endsWith("_slab")) return rand() < mossiness ? { Name: ns("mossy_stone_brick_slab"), nbt: e.nbt } : null
  if (n.endsWith("_wall")) return rand() < mossiness ? { Name: ns("mossy_stone_brick_wall"), nbt: e.nbt } : null
  if (n === "obsidian") return rand() < 0.15 ? { Name: ns("crying_obsidian"), nbt: e.nbt } : null
  return null
}

const BLACKSTONE = {
  cobblestone: "blackstone", mossy_cobblestone: "blackstone",
  stone: "polished_blackstone", stone_bricks: "polished_blackstone_bricks", mossy_stone_bricks: "polished_blackstone_bricks",
  cobblestone_stairs: "blackstone_stairs", mossy_cobblestone_stairs: "blackstone_stairs",
  stone_stairs: "polished_blackstone_stairs", stone_brick_stairs: "polished_blackstone_brick_stairs", mossy_stone_brick_stairs: "polished_blackstone_brick_stairs",
  cobblestone_slab: "blackstone_slab", mossy_cobblestone_slab: "blackstone_slab",
  smooth_stone_slab: "polished_blackstone_slab", stone_slab: "polished_blackstone_slab",
  stone_brick_slab: "polished_blackstone_brick_slab", mossy_stone_brick_slab: "polished_blackstone_brick_slab",
  stone_brick_wall: "polished_blackstone_brick_wall", mossy_stone_brick_wall: "polished_blackstone_brick_wall",
  cobblestone_wall: "blackstone_wall", mossy_cobblestone_wall: "blackstone_wall",
  chiseled_stone_bricks: "chiseled_polished_blackstone", cracked_stone_bricks: "cracked_polished_blackstone_bricks",
  iron_bars: "chain"
}

function applyBlackstone(e) {
  const to = BLACKSTONE[strip(e.Name)]
  if (!to) return null
  const p = e.Properties ?? {}
  const props = {}
  for (const k of ["facing", "half", "type"]) if (p[k] !== undefined) props[k] = p[k]
  return { Name: ns(to), Properties: Object.keys(props).length ? props : undefined, nbt: e.nbt }
}

function applyOne(proc, e, rand) {
  switch (strip(proc?.processor_type ?? "")) {
    case "rule": return applyRule(proc, e, rand)
    case "block_rot": {
      const rb = proc.rottable_blocks
      if (proc.__rotSet) { if (!proc.__rotSet.has(ns(e.Name ?? ""))) return null }
      else if (Array.isArray(rb) && !rb.map(strip).includes(strip(e.Name))) return null
      return rand() < (proc.integrity ?? 1) ? null : REMOVED
    }
    case "block_age": return applyBlockAge(proc, e, rand)
    case "blackstone_replace": return applyBlackstone(e)
    default: return null
  }
}

function runProcs(blocks, procs, rand) {
  for (const proc of procs ?? []) {
    if (strip(proc?.processor_type ?? "") === "capped") {
      const limit = sampleInt(proc.limit, rand)
      const order = shuffle(blocks.map((_, i) => i), rand)
      let changed = 0
      for (const i of order) {
        if (changed >= limit) break
        const b = blocks[i]
        if (!b) continue
        const r = applyOne(proc.delegate, b, rand)
        if (r === REMOVED) { blocks[i] = null; changed++ }
        else if (r) { blocks[i] = { ...r, pos: b.pos }; changed++ }
      }
      continue
    }
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (!b) continue
      const r = applyOne(proc, b, rand)
      if (r === REMOVED) blocks[i] = null
      else if (r) blocks[i] = { ...r, pos: b.pos }
    }
  }
  return blocks.filter(Boolean)
}

const materialize = s => s.blocks.map(b => {
  const e = s.palette[b.state] ?? {}
  return { Name: e.Name, Properties: e.Properties, nbt: b.nbt, pos: b.pos }
})

export async function applyProcessors(structure, entry, rand, loadTemplate) {
  const base = runProcs(materialize(structure), entry.procs, rand)
  for (const ov of entry.overlays ?? []) {
    let tpl = null
    try { tpl = await loadTemplate(ov.loc) } catch {}
    if (!tpl) continue
    const stamped = runProcs(materialize(tpl), ov.procs, rand).filter(b => !SKIP_OVERLAY.test(b.Name ?? ""))
    const byPos = new Map(base.map((b, i) => [b.pos.join(","), i]))
    for (const ob of stamped) {
      const i = byPos.get(ob.pos.join(","))
      if (i !== undefined) base[i] = ob
      else base.push(ob)
    }
  }
  const { palette, stateFor } = statePicker()
  const blocks = base.map(b => {
    const out = { state: stateFor(b.Name, b.Properties), pos: b.pos }
    if (b.nbt !== undefined) out.nbt = b.nbt
    return out
  })
  return { ...structure, palette, blocks }
}
