import { reactive, readonly } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { useSlicers } from "./useSlicers.js"
import { useStructures } from "./useStructures.js"
import { readLootTable, readTrialSpawnerConfig, rollLoot, sampleTable, stackKey, prettyName, isInspectable } from "../loot.js"
import { parseState } from "../transforms.js"
import { useBooks } from "./useBooks.js"
import { useStream } from "./useStream.js"

const sceneApi = useScene()
const buildApi = useBuild()
const streamApi = useStream()
const packs = usePacks()
const structures = useStructures()

// vanilla gui texture metrics; tiled guis compose header + slot-row strips + bottom, so rows can grow
const KINDS = {
  generic: { tex: "generic_54", texH: 222, tile: true, cols: 9, rows: 3, ox: 7, oy: 17 },
  shulker: { tex: "shulker_box", texH: 166, cols: 9, rows: 3, ox: 7, oy: 17 },
  dispenser: { tex: "dispenser", texH: 166, cols: 3, rows: 3, ox: 61, oy: 16 },
  hopper: { tex: "hopper", texH: 133, cols: 5, rows: 1, ox: 43, oy: 19 }
}

function kindOf(name) {
  const n = name.replace(/^minecraft:/, "")
  if (n === "dispenser" || n === "dropper" || n === "decorated_pot") return KINDS.dispenser
  if (n === "hopper" || /(^|_)shelf$/.test(n)) return KINDS.hopper
  if (/shulker_box$/.test(n)) return KINDS.shulker
  return KINDS.generic
}

const state = reactive({
  open: false,
  pick: null,
  aim: null,
  blockName: "",
  tableId: "",
  table: null,
  kind: null,
  stacks: [],
  error: "",
  note: "",
  tab: "loot",
  odds: null,
  oddsBusy: false,
  rolls: 0,
  pileTotal: 0,
  gui: null,
  guiTitle: "",
  item: null,
  fromFrame: false,
  dataRows: null,
  blurb: "",
  poolId: "",
  poolEntries: null,
  poolFallback: "",
  poolStack: []
})

let openSeq = 0 // stale async work from a previous open is discarded

const stripNs = s => typeof s === "string" ? s.replace(/^minecraft:/, "") : s

const spawnerEntity = nbt => nbt?.SpawnData?.entity?.id ?? nbt?.SpawnPotentials?.[0]?.data?.entity?.id ?? null

function dataRowsFor(name, p, nbt) {
  const rows = []
  function add(label, value, mono = false) {
    if (value === undefined || value === null || value === "") return
    rows.push({ label, value: String(value), mono })
  }
  if (name.endsWith("command_block")) {
    add("Type", name === "chain_command_block" ? "Chain" : name === "repeating_command_block" ? "Repeating" : "Impulse")
    add("Conditional", p.conditional === "true" ? "Yes" : "No")
    add("Behaviour", nbt?.auto ? "Always Active" : "Needs Redstone")
    rows.push({ label: "Command", value: nbt?.Command || "(empty)", mono: true, wide: true })
  } else if (name === "structure_block") {
    add("Mode", stripNs(nbt?.mode ?? p.mode ?? "").toUpperCase())
    add("Structure", stripNs(nbt?.name), true)
    if (nbt && [nbt.posX, nbt.posY, nbt.posZ].some(v => v)) add("Offset", `${nbt.posX ?? 0}, ${nbt.posY ?? 0}, ${nbt.posZ ?? 0}`, true)
    if (nbt && [nbt.sizeX, nbt.sizeY, nbt.sizeZ].some(v => v)) add("Size", `${nbt.sizeX ?? 0} × ${nbt.sizeY ?? 0} × ${nbt.sizeZ ?? 0}`, true)
    if (nbt?.rotation && nbt.rotation !== "NONE") add("Rotation", nbt.rotation)
    if (nbt?.mirror && nbt.mirror !== "NONE") add("Mirror", nbt.mirror)
    if (nbt?.integrity != null && nbt.integrity !== 1) {
      add("Integrity", nbt.integrity)
      add("Seed", nbt.seed)
    }
    add("Metadata", nbt?.metadata, true)
    if (nbt?.ignoreEntities != null) add("Entities", nbt.ignoreEntities ? "Ignored" : "Included")
  } else if (name === "jigsaw") {
    add("Name", stripNs(nbt?.name), true)
    add("Target", stripNs(nbt?.target), true)
    const fin = parseState(typeof nbt?.final_state === "string" ? nbt.final_state : "")
    rows.push({ label: "Turns into", value: stripNs(fin.Name), mono: true, props: fin.Properties, full: true, block: /(^|:)air$/.test(fin.Name) ? null : fin.Name })
    add("Joint", nbt?.joint)
    add("Orientation", p.orientation, true)
    if (nbt?.selection_priority) add("Selection priority", nbt.selection_priority)
    if (nbt?.placement_priority) add("Placement priority", nbt.placement_priority)
  } else if (name === "trial_spawner") {
    add("State", prettyName(p.trial_spawner_state ?? ""))
    if (p.ominous === "true") add("Ominous", "Yes")
    if (typeof nbt?.normal_config === "string") add("Config", stripNs(nbt.normal_config), true)
  } else if (/(^|_)spawner$/.test(name)) {
    const entity = spawnerEntity(nbt)
    if (entity) add("Entity", prettyName(stripNs(entity)))
    if (nbt?.MinSpawnDelay != null || nbt?.MaxSpawnDelay != null) {
      add("Spawn delay", `${nbt?.MinSpawnDelay ?? 200}–${nbt?.MaxSpawnDelay ?? 800} ticks`)
    }
    add("Spawn count", nbt?.SpawnCount)
    add("Spawn range", nbt?.SpawnRange)
    add("Activation range", nbt?.RequiredPlayerRange)
    add("Max nearby", nbt?.MaxNearbyEntities)
  }
  return rows
}

async function loadTrialRows(p, nbt) {
  const seq = openSeq
  const rows = []
  const add = (label, value, mono = false) => {
    if (value === undefined || value === null || value === "") return
    rows.push({ label, value: String(value), mono })
  }
  add("State", prettyName(p.trial_spawner_state ?? ""))
  if (p.ominous === "true") add("Ominous", "Yes")
  for (const [label, ref] of [["normal", nbt?.normal_config], ["ominous", nbt?.ominous_config]]) {
    const cfg = await readTrialSpawnerConfig(ref)
    if (!cfg) continue
    const ents = [...new Set((cfg.spawn_potentials ?? []).map(e => e?.data?.entity?.id).filter(Boolean))]
    if (ents.length) add(label === "normal" ? "Entity" : "Ominous entity", ents.map(e => prettyName(stripNs(e))).join(", "))
    if (label === "normal") {
      add("Total mobs", `${cfg.total_mobs ?? 6} (+${cfg.total_mobs_added_per_player ?? 2}/player)`)
      add("Simultaneous", `${cfg.simultaneous_mobs ?? 2} (+${cfg.simultaneous_mobs_added_per_player ?? 1}/player)`)
      add("Spawn interval", `${cfg.ticks_between_spawn ?? 40} ticks`)
      const loots = (cfg.loot_tables_to_eject ?? []).map(l => stripNs(l?.data ?? "")).filter(Boolean)
      if (loots.length) add("Reward loot", loots.join(", "), true)
    }
  }
  if (typeof nbt?.normal_config === "string") add("Config", stripNs(nbt.normal_config), true)
  if (seq !== openSeq) return
  state.dataRows = rows
}

let poolSeq = 0
async function loadPoolEntries(poolId) {
  const seq = ++poolSeq, oseq = openSeq
  state.poolId = stripNs(poolId)
  state.poolEntries = null
  state.poolFallback = ""
  try {
    const lib = await loadLibrary()
    const [ns, path] = poolId.includes(":") ? poolId.split(":") : ["minecraft", poolId]
    const buf = await lib.readFile(`data/${ns}/worldgen/template_pool/${path}.json`, packs.assets.value)
    if (!buf) return
    const json = JSON.parse(new TextDecoder().decode(buf))
    const out = []
    function collect(el, weight) {
      const type = stripNs(el?.element_type ?? "")
      if (type === "list_pool_element") {
        for (const c of el.elements ?? []) collect(c, weight)
      } else if (type === "feature_pool_element") {
        out.push({ label: "feature: " + stripNs(el.feature), weight })
      } else if (typeof el?.location === "string") {
        out.push({ label: stripNs(el.location), rel: el.location.replace(":", "/"), weight })
      } else {
        out.push({ label: "(nothing)", weight })
      }
    }
    for (const e of json.elements ?? []) collect(e.element, e.weight ?? 1)
    const total = out.reduce((a, o) => a + o.weight, 0) || 1
    out.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    if (seq !== poolSeq || oseq !== openSeq || !state.open) return
    state.poolEntries = out.map(o => ({
      ...o,
      pct: o.weight / total * 100,
      clickable: !!o.rel && structures.has(o.rel)
    }))
    const fb = stripNs(json.fallback ?? "")
    state.poolFallback = fb && fb !== "empty" ? fb : ""
  } catch {}
}

function openFallbackPool() {
  if (!state.poolFallback) return
  state.poolStack.push(state.poolId)
  loadPoolEntries(state.poolFallback)
}

function poolBack() {
  const prev = state.poolStack.pop()
  if (prev) loadPoolEntries(prev)
}

function jigsawBlurb(p, nbt) {
  const pool = stripNs(nbt?.pool ?? "")
  const target = stripNs(nbt?.target ?? "")
  const dir = (p.orientation ?? "").split("_")[0]
  const where = dir === "up" ? "on top of this block" : dir === "down" ? "underneath this block" : "beside this block"
  if (!pool || pool === "empty") {
    return "Places nothing itself: parent pieces attach here by its name."
  }
  const joint = dir === "up" || dir === "down"
    ? (nbt?.joint === "aligned" ? " The piece keeps its rotation." : " The piece can be randomly rotated.")
    : ""
  return `Places a random piece from the pool ${where}, joined at that piece's "${target}" jigsaw.${joint}`
}

// fields the game saves unconditionally at a spawn default identical for every
// mob (checked against decompiled save/read code); per-mob defaults stay visible
const NBT_ZERO_DEFAULTS = new Set([
  "HurtTime", "DeathTime", "HurtByTimestamp", "AbsorptionAmount", "FallFlying",
  "Invulnerable", "PortalCooldown", "fall_distance", "FallDistance",
  "InLove", "Age", "ForcedAge", "AgeLocked",
  "LeftHanded", "NoAI", "Leashed", "Sitting", "PlayerCreated",
  "Tame", "Bred", "EatingHaystack", "Temper", "Xp", "FoodLevel", "food_level",
  "Willing", "Riches", "CanBreakDoors", "TimeInOverworld", "Sheared",
  "ShowArms", "DisabledSlots", "Invisible", "Small", "NoBasePlate",
  "lastRestock", "LastRestock", "LastGossipDecay", "last_gossip_decay",
  "current_impulse_context_reset_grace_time"
])
// physics/session state that says nothing about a placed entity, any value
const NBT_NOISE = new Set(["OnGround", "PersistenceRequired", "Dimension", "CanPickUpLoot"])

// for hiding full-health mobs whose nbt carries no max_health attribute
const DEFAULT_MAX_HEALTH = {
  villager: 20, zombie_villager: 20, zombie: 20, husk: 20, drowned: 20,
  skeleton: 20, stray: 20, wither_skeleton: 20, bogged: 16, creeper: 20,
  spider: 16, cave_spider: 12, enderman: 40, witch: 26,
  piglin: 16, piglin_brute: 50, zombified_piglin: 20, hoglin: 40, zoglin: 40,
  pillager: 24, vindicator: 24, evoker: 24, illusioner: 32, ravager: 100,
  allay: 10, cat: 10, ocelot: 10, cow: 10, mooshroom: 10, pig: 10, sheep: 8,
  chicken: 4, goat: 10, camel: 32, sniffer: 14, frog: 10, axolotl: 14,
  armadillo: 12, bee: 10, iron_golem: 100, snow_golem: 4,
  squid: 10, glow_squid: 10, bat: 6, salmon: 3, cod: 3
}
const emptyObj = v => !!v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length
const vanillaDropChance = v => typeof v === "number" && Math.abs(v - 0.085) < 1e-6
const near = (a, b) => a === b || Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))

// registry defaults no vanilla mob ever overrides (checked across every
// supplier in the decompiled source); unknown/modded ids always stay
const ATTR_REGISTRY_DEFAULTS = {
  armor_toughness: 0, max_absorption: 0, scale: 1, gravity: 0.08,
  entity_interaction_range: 3, oxygen_bonus: 0, burning_time: 1,
  explosion_knockback_resistance: 0, water_movement_efficiency: 0,
  movement_efficiency: 0, waypoint_transmit_range: 0, bounciness: 0,
  air_drag_modifier: 1, friction_modifier: 1, name_tag_distance: 64,
  below_name_distance: 10, spawn_reinforcements: 0
}

// old saves use generic.maxHealth-style names; normalise to current snake_case ids
function attrId(s) {
  s = stripNs(String(s ?? ""))
  s = s.slice(s.indexOf(".") + 1)
  return s.replace(/[A-Z]/g, c => "_" + c.toLowerCase())
}

function filterDefaultNbt(nbt) {
  const attrs = nbt.attributes ?? nbt.Attributes
  let maxHealth = null
  if (Array.isArray(attrs)) for (const a of attrs) {
    if (attrId(a?.id ?? a?.Name) === "max_health") maxHealth = a.base ?? a.Base ?? maxHealth
  }
  const out = {}
  for (const [k, v] of Object.entries(nbt)) {
    if (NBT_ZERO_DEFAULTS.has(k) && (v === 0 || v === false || v === 0n)) continue
    if (NBT_NOISE.has(k)) continue
    if (Array.isArray(v) && !v.length) continue
    if (k === "Fire" && v <= 0) continue
    if (k === "Air" && v === 300) continue
    if (k === "ConversionTime" && v < 0) continue
    if (k === "CollarColor" && v === 14) continue
    if (k === "Color" && v === 0 && stripNs(nbt.id ?? "") === "sheep") continue
    if ((k === "OwnerUUID" || k === "Owner") && v === "") continue
    if (k === "Health") {
      const max = maxHealth ?? DEFAULT_MAX_HEALTH[stripNs(nbt.id ?? "")]
      if (max != null && near(v, max)) continue
    }
    // at rest under gravity: zero, or the first-tick fall velocity every placed mob carries
    if (k === "Motion" && Array.isArray(v) && near(v[0], 0) && near(v[2], 0) && v[1] <= 0 && v[1] > -0.1) continue
    if ((k === "HandItems" || k === "ArmorItems") && Array.isArray(v) && v.every(emptyObj)) continue
    if ((k === "HandDropChances" || k === "ArmorDropChances") && Array.isArray(v) && v.every(vanillaDropChance)) continue
    if ((k === "body_armor_drop_chance" || k === "saddle_drop_chance") && vanillaDropChance(v)) continue
    if (k === "Brain" && Object.keys(v ?? {}).every(x => x === "memories" && emptyObj(v.memories))) continue
    if ((k === "attributes" || k === "Attributes") && Array.isArray(v)) {
      const kept = v.filter(a => {
        if ((a?.modifiers ?? a?.Modifiers ?? []).length) return true
        const def = ATTR_REGISTRY_DEFAULTS[attrId(a?.id ?? a?.Name)]
        const base = a?.base ?? a?.Base
        return def == null || base == null || !near(base, def)
      })
      if (kept.length) out[k] = kept
      continue
    }
    out[k] = v
  }
  return out
}

function openEntity(e) {
  const id = stripNs(e.nbt?.id ?? "entity")
  state.pick = null
  state.error = ""
  state.note = ""
  state.item = null
  state.fromFrame = false
  state.tab = ""
  state.blockName = prettyName(id)
  state.blurb = ""
  state.tableId = ""
  state.table = null
  state.stacks = []
  state.gui = null
  state.guiTitle = ""
  state.poolId = ""
  state.poolEntries = null
  state.poolFallback = ""
  state.poolStack = []
  if (/^(glow_)?item_frame$/.test(id) && e.nbt.Item?.id) {
    const it = e.nbt.Item
    state.fromFrame = true
    state.dataRows = null
    state.tab = "loot"
    state.odds = null
    state.oddsBusy = false
    state.rolls = 0
    state.pileTotal = 0
    state.kind = KINDS.dispenser
    state.gui = KINDS.dispenser
    state.guiTitle = state.blockName
    state.stacks = [{ id: it.id, count: Number(it.count ?? it.Count ?? 1), components: it.components, tag: it.tag, slot: 4 }]
    openSeq++
    state.open = true
    return
  }
  const rows = [{ label: "Entity", value: id, mono: true }]
  if (e.pos) rows.push({ label: "Position", value: e.pos.map(v => +(+v).toFixed(3)).join(", "), mono: true })
  const yaw = e.nbt?.Rotation?.[0]
  if (yaw != null) rows.push({ label: "Rotation", value: `${Math.round(yaw)}°`, mono: true })
  const vd = e.nbt?.VillagerData
  if (vd?.profession) rows.push({ label: "Profession", value: prettyName(stripNs(vd.profession)) })
  if (vd?.type) rows.push({ label: "Variant", value: prettyName(stripNs(vd.type)) })
  const rest = filterDefaultNbt(e.nbt ?? {})
  for (const k of ["id", "Pos", "Rotation", "UUID"]) delete rest[k]
  if (Object.keys(rest).length) rows.push({ label: "NBT", tree: rest, wide: true })
  state.dataRows = rows
  openSeq++
  state.open = true
}

function openEntityMarker(m) {
  const stack = m.stack ?? []
  if (stack.length <= 1) return openEntity(stack[0] ?? m.e)
  state.error = ""
  state.note = ""
  state.blockName = "Overlapping entities"
  state.tableId = ""
  state.tab = ""
  state.dataRows = null
  state.blurb = ""
  state.table = null
  state.stacks = []
  state.gui = null
  state.guiTitle = ""
  state.poolId = ""
  state.poolEntries = null
  state.poolFallback = ""
  state.poolStack = []
  state.item = null
  state.fromFrame = false
  state.pick = stack.map(e => ({ e, label: prettyName(stripNs(e.nbt?.id ?? "entity")) }))
  openSeq++
  state.open = true
}

function openItem(stack) {
  state.item = stack
}

function itemBack() {
  state.item = null
}

// a double chest shares one lid across its two halves, so both blocks pose
const CW = { north: "east", east: "south", south: "west", west: "north" }
const SIDE_VEC = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
let openLids = []
function poseLids(block, entry, on) {
  const positions = [block.pos]
  const t = entry?.Properties?.type
  if ((t === "left" || t === "right") && entry?.Properties?.facing) {
    let dir = CW[entry.Properties.facing] ?? "east"
    if (t === "right") dir = CW[CW[dir]]
    const v = SIDE_VEC[dir]
    positions.push([block.pos[0] + v[0], block.pos[1], block.pos[2] + v[1]])
  }
  const books = useBooks()
  for (const pos of positions) {
    books.setLid(pos, on)
    if (streamApi.state.session) streamApi.provider.setLid(pos, on)
  }
  openLids = on ? positions : []
}

async function open(block) {
  const entry = block.entry ?? buildApi.current.value?.palette[block.state]
  const name = entry?.Name ?? "minecraft:chest"
  poseLids(block, entry, true)
  state.pick = null
  state.error = ""
  state.note = ""
  state.item = null
  state.fromFrame = false
  state.blockName = prettyName(name)
  state.kind = kindOf(name)
  state.dataRows = null
  state.blurb = ""
  state.poolId = ""
  state.poolEntries = null
  state.poolFallback = ""
  state.poolStack = []
  const bare = stripNs(name)
  if (/(^|_)(command_block|structure_block|jigsaw|spawner)$/.test(bare)) {
    state.tab = ""
    state.tableId = ""
    state.table = null
    state.stacks = []
    state.gui = null
    state.guiTitle = ""
    state.dataRows = dataRowsFor(bare, entry?.Properties ?? {}, block.nbt)
    if (bare === "jigsaw") state.blurb = jigsawBlurb(entry?.Properties ?? {}, block.nbt)
    openSeq++
    state.open = true
    if (bare === "jigsaw" && block.nbt?.pool && stripNs(block.nbt.pool) !== "empty") loadPoolEntries(block.nbt.pool)
    if (bare === "trial_spawner") loadTrialRows(entry?.Properties ?? {}, block.nbt)
    return
  }
  if (bare === "decorated_pot") {
    const books = useBooks()
    books.wobble(block.pos)
    if (streamApi.state.session) streamApi.provider.wobble(block.pos)
    if (!block.nbt?.LootTable) {
      const it = block.nbt?.item
      state.tab = "loot"
      state.tableId = ""
      state.table = null
      state.odds = null
      state.oddsBusy = false
      state.rolls = 0
      state.pileTotal = 0
      state.gui = state.kind
      state.guiTitle = state.blockName
      state.stacks = it?.id ? [{ id: it.id, count: Number(it.count ?? it.Count ?? 1), components: it.components, tag: it.tag, slot: 4 }] : []
      if (!it?.id) state.note = "This pot is empty."
      openSeq++
      state.open = true
      return
    }
  }
  if (bare === "lectern") {
    const it = block.nbt?.Book
    state.tab = "loot"
    state.tableId = ""
    state.table = null
    state.odds = null
    state.oddsBusy = false
    state.rolls = 0
    state.pileTotal = 0
    state.kind = KINDS.dispenser
    state.gui = KINDS.dispenser
    state.guiTitle = state.blockName
    state.stacks = it?.id ? [{ id: it.id, count: Number(it.count ?? it.Count ?? 1), components: it.components, tag: it.tag, slot: 4 }] : []
    if (!it?.id) state.note = "This lectern holds no book."
    openSeq++
    state.open = true
    return
  }
  state.tableId = (block.nbt?.LootTable ?? "").replace(/^minecraft:/, "")
  state.table = null
  state.stacks = []
  state.tab = "loot"
  state.odds = null
  state.oddsBusy = false
  state.rolls = 0
  state.pileTotal = 0
  state.gui = kindOf(name)
  state.guiTitle = state.blockName
  pile = []
  openSeq++
  state.open = true
  try {
    if (block.nbt?.LootTable) {
      const table = await readLootTable(block.nbt.LootTable)
      if (!table) {
        state.error = "loot table not found: " + state.tableId
        return
      }
      state.table = table
      await reroll()
    } else if (Array.isArray(block.nbt?.Items) && block.nbt.Items.length) {
      const cap = state.kind.cols * state.kind.rows
      const shelf = /(^|_)shelf$/.test(bare)
      state.stacks = block.nbt.Items.filter(it => it?.id).map(it => ({
        id: it.id,
        count: it.count ?? it.Count ?? 1,
        components: it.components,
        tag: it.tag,
        slot: shelf ? 1 + Math.min(2, Math.max(0, it.Slot ?? 0)) : Math.min(cap - 1, Math.max(0, it.Slot ?? 0))
      }))
      state.note = "Fixed contents stored in the structure."
    } else if (/(^|_)shelf$/.test(bare)) {
      state.note = "This shelf is empty."
    } else {
      state.note = "This container has no loot table."
    }
  } catch (err) {
    state.error = String(err)
  }
}

async function ensureOdds() {
  if (!state.table || state.odds || state.oddsBusy) return
  const seq = openSeq
  state.oddsBusy = true
  try {
    const odds = await sampleTable(state.table)
    if (seq === openSeq) state.odds = odds
  } finally {
    if (seq === openSeq) state.oddsBusy = false
  }
}

function setTab(tab) {
  state.tab = tab
  if (tab === "odds") ensureOdds()
}

let pile = []

function mergeRoll(loot) {
  for (const s of loot) {
    const k = stackKey(s)
    const ex = pile.find(t => t.key === k)
    if (ex) ex.count += s.count
    else pile.push({ key: k, id: s.id, components: s.components, count: s.count })
  }
}

// single rolls scatter into random slots like the game fills a chest
function display(scatter = false) {
  state.pileTotal = pile.reduce((a, s) => a + s.count, 0)
  const ownCap = state.kind.cols * state.kind.rows
  if (scatter && pile.length <= ownCap) {
    state.gui = state.kind
    state.guiTitle = state.blockName
    const slots = Array.from(Array(ownCap).keys())
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.random() * (i + 1) | 0
      ;[slots[i], slots[j]] = [slots[j], slots[i]]
    }
    state.stacks = pile.map((s, i) => ({ id: s.id, components: s.components, count: s.count, slot: slots[i] }))
  } else {
    state.gui = { ...KINDS.generic, rows: Math.max(3, Math.ceil(pile.length / KINDS.generic.cols)) }
    state.guiTitle = state.blockName
    const sorted = Array.from(pile).sort((a, b) => b.count - a.count || prettyName(a.id).localeCompare(prettyName(b.id)))
    state.stacks = sorted.map((s, i) => ({ id: s.id, components: s.components, count: s.count, slot: i }))
  }
}

async function reroll() {
  if (!state.table || !state.kind) return
  pile = []
  mergeRoll(await rollLoot(state.table))
  state.rolls = 1
  display(true)
}

async function addRoll(n = 1) {
  if (!state.table || !state.kind) return
  const seq = openSeq
  for (let i = 0; i < n; i++) {
    const loot = await rollLoot(state.table)
    if (seq !== openSeq || !state.open) return
    mergeRoll(loot)
    state.rolls++
  }
  display()
}

function close() {
  state.open = false
  state.pick = null
  state.item = null
  const books = useBooks()
  for (const pos of openLids) {
    books.setLid(pos, false)
    if (streamApi.state.session) streamApi.provider.setLid(pos, false)
  }
  openLids = []
  refreshHover()
}

let lastX = -1, lastY = -1, pickCanvas = null
function refreshHover() {
  requestAnimationFrame(() => {
    if (!pickCanvas || state.open) return
    if (document.elementFromPoint(lastX, lastY) !== pickCanvas) return
    hoverCheck({ clientX: lastX, clientY: lastY, buttons: 0 }, pickCanvas)
  })
}

// grid march instead of a triangle raycast: scanning every merged triangle per event stutters on huge scenes
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2()
let downX = 0, downY = 0, downT = 0
let hover = null

function screenRay(e, canvas) {
  const r = canvas.getBoundingClientRect()
  _ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height * 2 - 1))
  _ray.setFromCamera(_ndc, sceneApi.camera)
  return _ray.ray
}

function underRay(e, canvas) {
  const { origin: o, direction: d } = screenRay(e, canvas)
  if (streamApi.state.session) return streamApi.provider.pick(o.x, o.y, o.z, d.x, d.y, d.z)
  if (!buildApi.getRoot()) return null
  return buildApi.rayHit(o.x, o.y, o.z, d.x, d.y, d.z, 4000)
}

// easter egg: bells ring where you whack them, no hitbox or hover
function ringBellUnder(e, canvas) {
  const { origin: o, direction: d } = screenRay(e, canvas)
  if (streamApi.state.session) streamApi.provider.ringBell(o.x, o.y, o.z, d.x, d.y, d.z)
  else if (buildApi.getRoot()) buildApi.ringBell(o.x, o.y, o.z, d.x, d.y, d.z)
}

function inspectableUnder(e, canvas) {
  const h = underRay(e, canvas)
  if (h?.entity) return { marker: h.entity }
  return h?.container ? { block: h.container } : null
}

function aimFor(h) {
  if (h?.entity) {
    const stack = h.entity.stack ?? []
    const name = stack.length > 1 ? `${stack.length} entities` : stripNs(stack[0]?.nbt?.id ?? "entity")
    return { name, props: null }
  }
  const b = h?.door?.b ?? h?.container ?? h?.block
  if (!b) return null
  const e = b.entry ?? buildApi.current.value?.palette[b.state]
  if (!e?.Name) return null
  return { name: stripNs(e.Name), props: e.Properties ?? null }
}

function clearHover(canvas) {
  hover?.hide()
  state.aim = null
  if (!useSlicers().busy()) canvas.style.cursor = ""
}

// orbit controls only disable while walk mode holds the camera, so this stands
// in for "walking or suspended" without importing useWalk (import cycle)
const walking = () => sceneApi.controls?.enabled === false

function hoverCheck(e, canvas) {
  if (document.pointerLockElement || state.open || e.buttons || useSlicers().busy() || walking()) return clearHover(canvas)
  const h = underRay(e, canvas)
  state.aim = aimFor(h)
  const u = h?.entity ? { marker: h.entity } : h?.container ? { block: h.container } : null
  const box = u?.marker ? buildApi.boxForEntity(u.marker) : u?.block ? (h.box ?? buildApi.boxForBlock(u.block)) : null
  if (box) {
    hover ??= sceneApi.makeHighlight()
    hover.show(box)
    canvas.style.cursor = "pointer"
  } else {
    hover?.hide()
    if (!useSlicers().busy()) canvas.style.cursor = ""
  }
}

function initPicking(canvas) {
  pickCanvas = canvas
  addEventListener("pointermove", e => {
    lastX = e.clientX
    lastY = e.clientY
  })
  canvas.addEventListener("contextmenu", e => e.preventDefault())
  canvas.addEventListener("pointerdown", e => {
    downX = e.clientX
    downY = e.clientY
    downT = performance.now()
  })
  canvas.addEventListener("pointerup", e => {
    if (document.pointerLockElement || e.button !== 0 || useSlicers().busy() || walking()) return
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4 || performance.now() - downT > 400) return
    if (state.open) return
    const u = inspectableUnder(e, canvas)
    if (u) {
      clearHover(canvas)
      u.marker ? openEntityMarker(u.marker) : open(u.block)
    } else ringBellUnder(e, canvas)
  })
  let pending = null
  canvas.addEventListener("pointermove", e => {
    if (pending) { pending = e; return }
    pending = e
    requestAnimationFrame(() => {
      const ev = pending
      pending = null
      hoverCheck(ev, canvas)
    })
  })
  canvas.addEventListener("pointerleave", () => clearHover(canvas))
}

export function useContainer() {
  return { state: readonly(state), open, openEntity, openEntityMarker, openItem, itemBack, close, reroll, addRoll, setTab, ensureOdds, openFallbackPool, poolBack, initPicking, refreshHover }
}
