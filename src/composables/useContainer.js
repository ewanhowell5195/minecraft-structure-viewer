import { reactive, readonly } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { useStructures } from "./useStructures.js"
import { readLootTable, rollLoot, sampleTable, stackKey, prettyName, isInspectable } from "../loot.js"

// Clicking a loot container (chest, barrel, dispenser...) opens a modal with
// its loot table rules and a rolled inventory rendered in the vanilla GUI.
// Walk mode reaches here via useBuild.interact; orbit mode via a raycast on
// plain (non-drag) clicks.
const sceneApi = useScene()
const buildApi = useBuild()
const packs = usePacks()
const structures = useStructures()

// gui metrics: texture name, its full height, how much of the top is the
// container section, and where the slot grid starts. tiled guis compose
// header + n slot-row strips + bottom, so their row count can grow
const KINDS = {
  generic: { tex: "generic_54", texH: 222, cropH: 71, tile: true, cols: 9, rows: 3, ox: 7, oy: 17 },
  shulker: { tex: "shulker_box", texH: 166, cropH: 71, tile: true, cols: 9, rows: 3, ox: 7, oy: 17 },
  dispenser: { tex: "dispenser", texH: 166, cropH: 71, cols: 3, rows: 3, ox: 61, oy: 16 },
  hopper: { tex: "hopper", texH: 133, cropH: 43, cols: 5, rows: 1, ox: 43, oy: 19 }
}

function kindOf(name) {
  const n = name.replace(/^minecraft:/, "")
  if (n === "dispenser" || n === "dropper") return KINDS.dispenser
  if (n === "hopper") return KINDS.hopper
  if (/shulker_box$/.test(n)) return KINDS.shulker
  return KINDS.generic
}

const state = reactive({
  open: false,
  blockName: "",
  tableId: "",
  table: null,
  kind: null,
  stacks: [],
  error: "",
  note: "",
  tab: "loot",     // loot | odds | rules
  odds: null,      // sampleTable result, computed once per open on demand
  oddsBusy: false,
  rolls: 0,        // opens accumulated into the gui pile
  pileTotal: 0,
  gui: null,       // the gui actually drawn (accumulated piles grow a chest)
  guiTitle: "",
  dataRows: null,  // technical blocks (command/structure/jigsaw) show these
  poolId: "",      // the jigsaw's template pool
  poolEntries: null, // what that pool can place, weighted
  poolFallback: ""
})

let openSeq = 0 // bumps per open(): stale async work from a previous container is discarded

const stripNs = s => typeof s === "string" ? s.replace(/^minecraft:/, "") : s

// technical block nbt as readable label/value rows
function dataRowsFor(name, p, nbt) {
  const rows = []
  const add = (label, value, mono = false) => {
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
    add("Turns into", stripNs(nbt?.final_state), true)
    add("Joint", nbt?.joint)
    add("Orientation", p.orientation, true)
    if (nbt?.selection_priority) add("Selection priority", nbt.selection_priority)
    if (nbt?.placement_priority) add("Placement priority", nbt.placement_priority)
  }
  return rows
}

// what the jigsaw's template pool can place: weighted entries, nested list
// elements flattened, features and empties shown but not loadable
async function loadPoolEntries(poolId) {
  const seq = openSeq
  try {
    const lib = await loadLibrary()
    const [ns, path] = poolId.includes(":") ? poolId.split(":") : ["minecraft", poolId]
    const buf = await lib.readFile(`data/${ns}/worldgen/template_pool/${path}.json`, packs.assets.value)
    if (!buf) return
    const json = JSON.parse(new TextDecoder().decode(buf))
    const out = []
    const collect = (el, weight) => {
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
    if (seq !== openSeq || !state.open) return
    state.poolEntries = out.map(o => ({
      ...o,
      pct: o.weight / total * 100,
      clickable: !!o.rel && structures.has(o.rel)
    }))
    const fb = stripNs(json.fallback ?? "")
    state.poolFallback = fb && fb !== "empty" ? fb : ""
  } catch {}
}

async function open(block) {
  const entry = buildApi.current.value?.palette[block.state]
  const name = entry?.Name ?? "minecraft:chest"
  state.error = ""
  state.note = ""
  state.blockName = prettyName(name)
  state.kind = kindOf(name)
  state.dataRows = null
  state.poolId = ""
  state.poolEntries = null
  state.poolFallback = ""
  const bare = stripNs(name)
  if (/(^|_)(command_block|structure_block|jigsaw)$/.test(bare)) {
    state.tableId = ""
    state.table = null
    state.stacks = []
    state.gui = null
    state.guiTitle = ""
    state.dataRows = dataRowsFor(bare, entry?.Properties ?? {}, block.nbt)
    openSeq++
    state.open = true
    if (bare === "jigsaw" && block.nbt?.pool && stripNs(block.nbt.pool) !== "empty") {
      state.poolId = stripNs(block.nbt.pool)
      loadPoolEntries(block.nbt.pool)
    }
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
      // pre-filled inventory (mansion allium/sapling chests and such): show
      // the exact items in their saved slots
      const cap = state.kind.cols * state.kind.rows
      state.stacks = block.nbt.Items.filter(it => it?.id).map(it => ({
        id: it.id,
        count: it.count ?? it.Count ?? 1,
        components: it.components,
        slot: Math.min(cap - 1, Math.max(0, it.Slot ?? 0))
      }))
      state.note = "Fixed contents stored in the structure."
    } else {
      state.note = "This container has no loot table."
    }
  } catch (err) {
    state.error = String(err)
  }
}

// the odds and sim views need the measured drop rates; compute them once
// per open, in the background, the first time either tab wants them
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

// the gui shows an accumulated pile of opens: re-roll starts a fresh one,
// add-roll opens the container again on top, biggest stacks first
let pile = []

function mergeRoll(loot) {
  for (const s of loot) {
    const k = stackKey(s)
    const ex = pile.find(t => t.key === k)
    if (ex) ex.count += s.count
    else pile.push({ key: k, id: s.id, components: s.components, count: s.count })
  }
}

// a fresh single open scatters into the block's own gui in random slots
// like the game fills a chest. accumulated piles switch to a chest gui
// that grows rows to fit, biggest stacks first, with the stats as title
function display(scatter = false) {
  state.pileTotal = pile.reduce((a, s) => a + s.count, 0)
  const ownCap = state.kind.cols * state.kind.rows
  if (scatter && pile.length <= ownCap) {
    state.gui = state.kind
    state.guiTitle = state.blockName
    const slots = [...Array(ownCap).keys()]
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.random() * (i + 1) | 0
      ;[slots[i], slots[j]] = [slots[j], slots[i]]
    }
    state.stacks = pile.map((s, i) => ({ id: s.id, components: s.components, count: s.count, slot: slots[i] }))
  } else {
    state.gui = { ...KINDS.generic, rows: Math.max(3, Math.ceil(pile.length / KINDS.generic.cols)) }
    state.guiTitle = state.blockName
    const sorted = [...pile].sort((a, b) => b.count - a.count || prettyName(a.id).localeCompare(prettyName(b.id)))
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
    if (seq !== openSeq || !state.open) return // a different container opened meanwhile
    mergeRoll(loot)
    state.rolls++
  }
  display()
}

function close() {
  state.open = false
}

// orbit-mode picking: a click that didn't drag raycasts the built meshes,
// steps one unit inside the hit face, and opens whatever loot container
// lives in that cell. hovering one shows the block highlight + a pointer
// cursor. walking is excluded (pointer lock owns clicks there)
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2()
let downX = 0, downY = 0, downT = 0
let hover = null

function containerUnder(e, canvas) {
  const root = buildApi.getRoot()
  if (!root) return null
  const r = canvas.getBoundingClientRect()
  _ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height * 2 - 1))
  _ray.setFromCamera(_ndc, sceneApi.camera)
  const hit = _ray.intersectObject(root, true).find(h => h.face && h.object.visible)
  if (!hit) return null
  const p = hit.point.addScaledVector(hit.face.normal, -1)
  const b = buildApi.blockEntryAt(p.x, p.y, p.z)
  if (!b) return null
  const name = buildApi.current.value?.palette[b.state]?.Name
  return isInspectable(name) || b.nbt?.LootTable ? b : null
}

function clearHover(canvas) {
  hover?.hide()
  canvas.style.cursor = ""
}

function hoverCheck(e, canvas) {
  if (document.pointerLockElement || state.open || e.buttons) return clearHover(canvas)
  const b = containerUnder(e, canvas)
  const box = b && buildApi.boxForBlock(b)
  if (box) {
    hover ??= sceneApi.makeHighlight()
    hover.show(box)
    canvas.style.cursor = "pointer"
  } else clearHover(canvas)
}

function initPicking(canvas) {
  canvas.addEventListener("contextmenu", e => e.preventDefault())
  canvas.addEventListener("pointerdown", e => {
    downX = e.clientX
    downY = e.clientY
    downT = performance.now()
  })
  canvas.addEventListener("pointerup", e => {
    if (document.pointerLockElement || e.button !== 0) return
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4 || performance.now() - downT > 400) return
    if (state.open) return
    const b = containerUnder(e, canvas)
    if (b) {
      clearHover(canvas)
      open(b)
    }
  })
  // hover raycasts throttle to one per frame, and skip entirely mid-drag
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
  return { state: readonly(state), open, close, reroll, addRoll, setTab, ensureOdds, initPicking }
}
