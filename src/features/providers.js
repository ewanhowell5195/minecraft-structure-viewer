// noise-driven providers can't run without the world's noise stack; they
// degrade to random picks over the same state pool

export const nextInt = (rand, n) => Math.floor(rand() * n)

export function pickWeighted(entries, rand) {
  let total = 0
  for (const e of entries) total += e.weight ?? 1
  let roll = rand() * total
  for (const e of entries) {
    roll -= e.weight ?? 1
    if (roll < 0) return e
  }
  return entries[entries.length - 1]
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

const strip = t => (t ?? "").replace("minecraft:", "")

export function sampleInt(p, rand) {
  if (typeof p === "number") return p
  if (p == null) return 0
  switch (strip(p.type)) {
    case "constant": return p.value
    case "uniform": return p.min_inclusive + nextInt(rand, p.max_inclusive - p.min_inclusive + 1)
    case "biased_to_bottom": return p.min_inclusive + nextInt(rand, nextInt(rand, p.max_inclusive - p.min_inclusive + 1) + 1)
    case "clamped": return Math.min(p.max_inclusive, Math.max(p.min_inclusive, sampleInt(p.source, rand)))
    case "clamped_normal": return Math.min(p.max_inclusive, Math.max(p.min_inclusive, Math.round(gaussian(rand) * p.deviation + p.mean)))
    case "weighted_list": return sampleInt(pickWeighted(p.distribution, rand).data, rand)
    case "trapezoid": {
      const min = p.min ?? p.min_inclusive, max = p.max ?? p.max_inclusive
      const range = max - min - (p.plateau ?? 0)
      const a = rand() * range, b = rand() * range
      return min + Math.floor((p.plateau ?? 0) / 2 + Math.min(a, b) + Math.abs(a - b) / 2)
    }
  }
  return typeof p.value === "number" ? p.value : 0
}

export function intBounds(p) {
  if (typeof p === "number") return [p, p]
  if (p == null) return [0, 0]
  switch (strip(p.type)) {
    case "constant": return [p.value, p.value]
    case "clamped": return [p.min_inclusive, p.max_inclusive]
    case "weighted_list": {
      const bounds = p.distribution.map(e => intBounds(e.data))
      return [Math.min(...bounds.map(b => b[0])), Math.max(...bounds.map(b => b[1]))]
    }
    case "trapezoid": return [p.min ?? p.min_inclusive, p.max ?? p.max_inclusive]
  }
  return [p.min_inclusive ?? p.value ?? 0, p.max_inclusive ?? p.value ?? 0]
}

export function sampleFloat(p, rand) {
  if (typeof p === "number") return p
  if (p == null) return 0
  switch (strip(p.type)) {
    case "constant": return p.value
    case "uniform": return p.min_inclusive + rand() * (p.max_exclusive - p.min_inclusive)
    case "clamped_normal": return Math.min(p.max, Math.max(p.min, gaussian(rand) * p.deviation + p.mean))
    case "trapezoid": {
      const range = p.max - p.min - (p.plateau ?? 0)
      const a = rand() * range, b = rand() * range
      return p.min + (p.plateau ?? 0) / 2 + Math.min(a, b) + Math.abs(a - b) / 2
    }
  }
  return typeof p.value === "number" ? p.value : 0
}

// tags can't be resolved; known vanilla tags get a hand-kept pool
const TAG_POOLS = {
  "minecraft:corals": ["tube_coral", "brain_coral", "bubble_coral", "fire_coral", "horn_coral"],
  "minecraft:coral_plants": ["tube_coral", "brain_coral", "bubble_coral", "fire_coral", "horn_coral"],
  "minecraft:coral_blocks": ["tube_coral_block", "brain_coral_block", "bubble_coral_block", "fire_coral_block", "horn_coral_block"],
  "minecraft:wall_corals": ["tube_coral_wall_fan", "brain_coral_wall_fan", "bubble_coral_wall_fan", "fire_coral_wall_fan", "horn_coral_wall_fan"]
}

const PROVIDER_TYPES = {
  simple_state_provider: "simple",
  weighted_state_provider: "weighted",
  rotated_block_provider: "rotated",
  randomized_int_state_provider: "randomized_int",
  rule_based_state_provider: "rule_based",
  noise_provider: "noise",
  dual_noise_provider: "dual_noise",
  noise_threshold_provider: "noise_threshold",
  random_block_provider: "random_block"
}

export function providerType(p) {
  if (!p || typeof p !== "object" || p.type === undefined) return null
  const t = strip(p.type)
  return PROVIDER_TYPES[t] ?? t
}

export function sampleState(p, rand) {
  if (p == null) return null
  switch (providerType(p)) {
    case null: return p
    case "simple": return p.state
    case "weighted": return pickWeighted(p.entries, rand).data
    case "rotated": {
      const dirs = ["down", "up", "north", "south", "west", "east"]
      const dir = p.direction ? strip(p.direction) : dirs[nextInt(rand, 6)]
      const base = sampleState(p.state, rand)
      if (!base?.id) return base
      const props = { ...(base.properties ?? {}) }
      if ("axis" in props) props.axis = dir === "down" || dir === "up" ? "y" : dir === "north" || dir === "south" ? "z" : "x"
      else if (("facing" in props || /_wall_fan$/.test(strip(base.id))) && dir !== "up" && dir !== "down") props.facing = dir
      return { id: base.id, properties: props }
    }
    case "randomized_int": {
      const s = sampleState(p.source, rand)
      return { id: s.id, properties: { ...(s.properties ?? {}), [p.property]: String(sampleInt(p.values, rand)) } }
    }
    case "rule_based": {
      const rule = p.rules?.[0]
      if (rule?.then) return sampleState(rule.then, rand)
      return p.fallback ? sampleState(p.fallback, rand) : null
    }
    case "copy_properties": return sampleState(p.source, rand)
    case "noise":
    case "dual_noise": {
      const states = p.states ?? []
      return states.length ? states[nextInt(rand, states.length)] : null
    }
    case "noise_threshold": {
      if (rand() < 0.5 && p.default_state) return p.default_state
      const pool = rand() < (p.high_chance ?? 0.5) ? p.high_states : p.low_states
      const states = pool?.length ? pool : [p.default_state]
      return states[nextInt(rand, states.length)]
    }
    case "random_block": {
      const pool = Array.isArray(p.blocks)
        ? p.blocks.map(b => b.replace("minecraft:", ""))
        : TAG_POOLS[String(p.blocks).replace(/^#/, "")] ?? null
      return pool ? { id: "minecraft:" + pool[nextInt(rand, pool.length)] } : null
    }
  }
  return p.state ?? null
}

const ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/

export async function inlineProviders(node, readProvider, memo = new Map()) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = await inlineProviders(node[i], readProvider, memo)
    return node
  }
  if (!node || typeof node !== "object") return node
  for (const [k, v] of Object.entries(node)) {
    if (typeof v !== "string") {
      node[k] = await inlineProviders(v, readProvider, memo)
      continue
    }
    if (k === "type" || !ID_RE.test(v)) continue
    if (!memo.has(v)) {
      memo.set(v, null)
      const hit = await readProvider(v)
      if (hit) memo.set(v, await inlineProviders(hit, readProvider, memo))
    }
    const hit = memo.get(v)
    if (hit) node[k] = structuredClone(hit)
  }
  return node
}
