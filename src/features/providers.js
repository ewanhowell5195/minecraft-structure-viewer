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

export function sampleState(p, rand) {
  if (p == null) return null
  switch (strip(p.type)) {
    case "simple_state_provider": return p.state
    case "weighted_state_provider": return pickWeighted(p.entries, rand).data
    case "rotated_block_provider": {
      const dirs = ["down", "up", "north", "south", "west", "east"]
      const dir = p.direction ? strip(p.direction) : dirs[nextInt(rand, 6)]
      const base = p.state?.type ? sampleState(p.state, rand) : p.state
      if (!base?.Name) return base
      const props = { ...(base.Properties ?? {}) }
      if ("axis" in props) props.axis = dir === "down" || dir === "up" ? "y" : dir === "north" || dir === "south" ? "z" : "x"
      else if (("facing" in props || /_wall_fan$/.test(strip(base.Name))) && dir !== "up" && dir !== "down") props.facing = dir
      return { Name: base.Name, Properties: props }
    }
    case "randomized_int_state_provider": {
      const s = sampleState(p.source, rand)
      return { Name: s.Name, Properties: { ...(s.Properties ?? {}), [p.property]: String(sampleInt(p.values, rand)) } }
    }
    case "rule_based_state_provider": {
      const rule = p.rules?.[0]
      if (rule?.then) return sampleState(rule.then, rand)
      return p.fallback ? sampleState(p.fallback, rand) : null
    }
    case "noise_provider":
    case "dual_noise_provider": {
      const states = p.states ?? []
      return states.length ? states[nextInt(rand, states.length)] : null
    }
    case "noise_threshold_provider": {
      if (rand() < 0.5 && p.default_state) return p.default_state
      const pool = rand() < (p.high_chance ?? 0.5) ? p.high_states : p.low_states
      const states = pool?.length ? pool : [p.default_state]
      return states[nextInt(rand, states.length)]
    }
    case "random_block_provider": {
      const pool = Array.isArray(p.blocks)
        ? p.blocks.map(b => b.replace("minecraft:", ""))
        : TAG_POOLS[String(p.blocks).replace(/^#/, "")] ?? null
      return pool ? { Name: "minecraft:" + pool[nextInt(rand, pool.length)] } : null
    }
  }
  return p.state ?? null
}
