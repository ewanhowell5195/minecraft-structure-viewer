import { loadLibrary } from "./lib.js"
import { usePacks } from "./composables/usePacks.js"

const packs = usePacks()

const strip = s => typeof s === "string" ? s.replace(/^minecraft:/, "") : s

export const isContainer = name =>
  /(^|_)(chest|barrel|shulker_box|dispenser|dropper|hopper|shelf)$/.test((name || "").replace(/^minecraft:/, ""))

export const isInspectable = name =>
  isContainer(name) || /(^|_)(command_block|structure_block|jigsaw|lectern|decorated_pot)$/.test((name || "").replace(/^minecraft:/, ""))

export const prettyName = n => strip(n).replace(/_/g, " ").replace(/(^|\s)[a-z]/g, c => c.toUpperCase())

const tableCache = new Map()
let tableCacheVersion = -1

export function readLootTable(id) {
  if (!id) return Promise.resolve(null)
  if (packs.state.assetsVersion !== tableCacheVersion) {
    tableCacheVersion = packs.state.assetsVersion
    tableCache.clear()
  }
  if (!tableCache.has(id)) tableCache.set(id, readLootTableRaw(id))
  return tableCache.get(id)
}

async function readLootTableRaw(id) {
  const lib = await loadLibrary()
  const assets = packs.assets.value
  const [ns, path] = id.includes(":") ? id.split(":") : ["minecraft", id]
  for (const dir of ["loot_table", "loot_tables"]) {
    const buf = await lib.readFile(`data/${ns}/${dir}/${path}.json`, assets)
    if (buf) return JSON.parse(new TextDecoder().decode(buf))
  }
  return null
}

// block entities usually hold the registry id, but inline config objects are legal
export async function readTrialSpawnerConfig(ref) {
  if (!ref) return null
  if (typeof ref === "object") return ref
  const lib = await loadLibrary()
  const assets = packs.assets.value
  const [ns, path] = ref.includes(":") ? ref.split(":") : ["minecraft", ref]
  try {
    const buf = await lib.readFile(`data/${ns}/trial_spawner/${path}.json`, assets)
    return buf ? JSON.parse(new TextDecoder().decode(buf)) : null
  } catch { return null }
}

function rollNum(n, int = false) {
  if (n == null) return 1
  if (typeof n === "number") return n
  const t = strip(n.type || "")
  if (t === "constant") return n.value ?? 1
  if (t === "binomial") {
    let c = 0
    const N = rollNum(n.n, true), p = rollNum(n.p)
    for (let i = 0; i < N; i++) if (Math.random() < p) c++
    return c
  }
  if (n.min != null || n.max != null) {
    const a = rollNum(n.min ?? 0, int), b = rollNum(n.max ?? a, int)
    return int ? a + Math.floor(Math.random() * (b - a + 1)) : a + Math.random() * (b - a)
  }
  return n.value ?? 1
}

// only random_chance is meaningful without world context; others pass
const passes = conditions => (conditions ?? []).every(c =>
  strip(c.condition || "") !== "random_chance" || Math.random() < (c.chance ?? 1))

function applyFunctions(fns, stack) {
  for (const f of fns ?? []) {
    const t = strip(f.function || "")
    if (!passes(f.conditions)) continue
    if (t === "set_count") stack.count = Math.max(1, Math.round(rollNum(f.count, true)))
    else if (t === "enchant_randomly" || t === "enchant_with_levels") stack.enchanted = true
    else if (t === "set_potion") stack.components = { "minecraft:potion_contents": { potion: f.id } }
  }
}

async function applyEntry(entry, pool, out) {
  const type = strip(entry.type || "item")
  if (type === "item") {
    const stack = { id: entry.name, count: 1 }
    applyFunctions(entry.functions, stack)
    applyFunctions(pool?.functions, stack)
    out.push(stack)
  } else if (type === "loot_table") {
    const t = typeof entry.value === "object" ? entry.value : await readLootTable(entry.value ?? entry.name)
    if (t) await rollInto(t, out)
  } else if (type === "alternatives" || type === "group" || type === "sequence") {
    for (const c of entry.children ?? []) {
      if (type === "alternatives") {
        if (passes(c.conditions)) { await applyEntry(c, pool, out); break }
      } else await applyEntry(c, pool, out)
    }
  }
}

function pickEntry(entries) {
  const usable = entries.filter(e => passes(e.conditions))
  const total = usable.reduce((a, e) => a + (e.weight ?? 1), 0)
  let r = Math.random() * total
  for (const e of usable) {
    r -= e.weight ?? 1
    if (r < 0) return e
  }
  return null
}

async function rollInto(table, out) {
  for (const pool of table.pools ?? []) {
    if (!passes(pool.conditions)) continue
    const n = Math.round(rollNum(pool.rolls ?? 1, true))
    for (let i = 0; i < n; i++) {
      const entry = pickEntry(pool.entries ?? [])
      if (entry) await applyEntry(entry, pool, out)
    }
  }
}

export async function rollLoot(table) {
  const out = []
  await rollInto(table, out)
  return out.filter(s => s.id)
}

// every item a table can possibly drop, following nested tables and set_contents;
// unlike rollLoot this ignores weights/conditions so it enumerates, not samples
export async function lootTableItems(table, out = new Set(), seen = new Set()) {
  const t = typeof table === "object" ? table : await readLootTable(table)
  if (!t) return out
  for (const pool of t.pools ?? []) {
    for (const entry of pool.entries ?? []) await entryItems(entry, out, seen)
  }
  return out
}

async function entryItems(entry, out, seen) {
  const type = strip(entry.type || "item")
  if (type === "item") {
    if (typeof entry.name === "string") out.add(strip(entry.name))
  } else if (type === "loot_table") {
    const ref = entry.value ?? entry.name
    if (typeof ref === "object") await lootTableItems(ref, out, seen)
    else if (typeof ref === "string" && !seen.has(ref)) {
      seen.add(ref)
      await lootTableItems(ref, out, seen)
    }
  } else if (type === "alternatives" || type === "group" || type === "sequence") {
    for (const c of entry.children ?? []) await entryItems(c, out, seen)
  }
  for (const f of entry.functions ?? []) {
    if (strip(f.function || "") !== "set_contents") continue
    for (const nested of f.entries ?? []) await entryItems(nested, out, seen)
  }
}

export const stackKey = s => s.id + "|" + JSON.stringify(s.components ?? null)

export async function sampleTable(table, opens = 10000) {
  const tally = new Map()
  const perOpen = new Map()
  for (let i = 0; i < opens; i++) {
    perOpen.clear()
    for (const s of await rollLoot(table)) {
      const k = stackKey(s)
      perOpen.set(k, (perOpen.get(k) ?? 0) + s.count)
      if (!tally.has(k)) tally.set(k, { id: s.id, components: s.components, hits: 0, total: 0, min: Infinity, max: 0 })
    }
    for (const [k, count] of perOpen) {
      const t = tally.get(k)
      t.hits++
      t.total += count
      t.min = Math.min(t.min, count)
      t.max = Math.max(t.max, count)
    }
  }
  return Array.from(tally.values()).map(t => ({
    id: t.id,
    components: t.components,
    chance: t.hits / opens,
    avg: t.total / t.hits,
    min: t.min,
    max: t.max
  })).sort((a, b) => b.chance - a.chance || strip(a.id).localeCompare(strip(b.id)))
}

function fmtNum(n) {
  if (n == null) return "1"
  if (typeof n === "number") return String(n)
  const t = strip(n.type || "")
  if (t === "constant") return String(n.value ?? 1)
  if (t === "binomial") return `binomial(${fmtNum(n.n)} tries, ${fmtNum(n.p)})`
  if (n.min != null || n.max != null) return `${fmtNum(n.min ?? 0)}-${fmtNum(n.max ?? "?")}`
  return String(n.value ?? 1)
}

export function describeTable(table) {
  return (table.pools ?? []).map(pool => {
    const entries = pool.entries ?? []
    const total = entries.reduce((a, e) => a + (e.weight ?? 1), 0) || 1
    const chance = (pool.conditions ?? []).find(c => strip(c.condition || "") === "random_chance")
    return {
      rolls: fmtNum(pool.rolls ?? 1),
      bonus: pool.bonus_rolls ? fmtNum(pool.bonus_rolls) : null,
      chance: chance ? Math.round((chance.chance ?? 1) * 100) + "% chance" : null,
      entries: entries.map(e => {
        const type = strip(e.type || "item")
        const fns = e.functions ?? []
        const sc = fns.find(f => strip(f.function) === "set_count")
        const notes = []
        for (const f of fns) {
          const fn = strip(f.function || "")
          if (fn === "enchant_randomly") notes.push("enchanted")
          else if (fn === "enchant_with_levels") notes.push(`enchanted, ${fmtNum(f.levels)} levels`)
          else if (fn === "set_potion") notes.push(strip(f.id))
          else if (fn === "exploration_map") notes.push("treasure map")
          else if (fn === "set_instrument") notes.push("random instrument")
          else if (fn === "set_damage") notes.push("damaged")
          else if (fn === "set_stew_effect") notes.push("random effect")
        }
        return {
          name: type === "item" ? strip(e.name)
            : type === "loot_table" ? "table: " + (typeof e.value === "string" ? strip(e.value) : strip(e.name ?? "inline"))
            : type,
          pct: +((e.weight ?? 1) / total * 100).toFixed(1),
          count: sc ? fmtNum(sc.count) : null,
          note: notes.join(", ")
        }
      })
    }
  })
}
