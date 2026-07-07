import { reactive, readonly } from "vue"
import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { readLootTable, rollLoot, sampleTable, stackKey, prettyName, isContainer } from "../loot.js"

// Clicking a loot container (chest, barrel, dispenser...) opens a modal with
// its loot table rules and a rolled inventory rendered in the vanilla GUI.
// Walk mode reaches here via useBuild.interact; orbit mode via a raycast on
// plain (non-drag) clicks.
const sceneApi = useScene()
const buildApi = useBuild()

// gui metrics: texture name, its full height, how much of the top is the
// container section, and where the slot grid starts
const KINDS = {
  generic: { tex: "generic_54", texH: 222, cropH: 71, cols: 9, rows: 3, ox: 7, oy: 17 },
  shulker: { tex: "shulker_box", texH: 166, cropH: 71, cols: 9, rows: 3, ox: 7, oy: 17 },
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
  tab: "loot",     // loot | odds | sim | rules
  odds: null,      // sampleTable result, computed once per open on demand
  oddsBusy: false,
  simRolls: 0,
  simStacks: []    // accumulated { key, id, components, count }
})

let openSeq = 0 // bumps per open(): stale async work from a previous container is discarded

async function open(block) {
  const entry = buildApi.current.value?.palette[block.state]
  const name = entry?.Name ?? "minecraft:chest"
  state.error = ""
  state.note = ""
  state.blockName = prettyName(name)
  state.kind = kindOf(name)
  state.tableId = (block.nbt?.LootTable ?? "").replace(/^minecraft:/, "")
  state.table = null
  state.stacks = []
  state.tab = "loot"
  state.odds = null
  state.oddsBusy = false
  state.simRolls = 0
  state.simStacks = []
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
  if (tab === "odds" || tab === "sim") ensureOdds()
}

// one more simulated open, merged into the running totals
async function simRoll() {
  if (!state.table) return
  const seq = openSeq
  const loot = await rollLoot(state.table)
  if (seq !== openSeq || !state.open) return // a different container opened meanwhile
  state.simRolls++
  for (const s of loot) {
    const k = stackKey(s)
    const ex = state.simStacks.find(t => t.key === k)
    if (ex) ex.count += s.count
    else state.simStacks.push({ key: k, id: s.id, components: s.components, count: s.count })
  }
}

function simReset() {
  state.simRolls = 0
  state.simStacks = []
}

async function reroll() {
  if (!state.table || !state.kind) return
  const loot = await rollLoot(state.table)
  const cap = state.kind.cols * state.kind.rows
  // over capacity: merge same-item stacks until it fits (or give up and cap)
  while (loot.length > cap) {
    const j = loot.findIndex((o, oi) => loot.findIndex(s => s.id === o.id) < oi)
    if (j < 0) break
    const i = loot.findIndex(s => s.id === loot[j].id)
    loot[i].count += loot[j].count
    loot.splice(j, 1)
  }
  const slots = [...Array(cap).keys()]
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0
    ;[slots[i], slots[j]] = [slots[j], slots[i]]
  }
  state.stacks = loot.slice(0, cap).map((s, i) => ({ ...s, slot: slots[i] }))
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
  return isContainer(name) || b.nbt?.LootTable ? b : null
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
  return { state: readonly(state), open, close, reroll, setTab, ensureOdds, simRoll, simReset, initPicking }
}
