import { reactive, readonly } from "vue"
import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { readLootTable, rollLoot } from "../loot.js"

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

const pretty = n => n.replace(/^minecraft:/, "").replace(/_/g, " ").replace(/(^|\s)[a-z]/g, c => c.toUpperCase())

const state = reactive({
  open: false,
  blockName: "",
  tableId: "",
  table: null,
  kind: null,
  stacks: [],
  error: ""
})

async function open(block) {
  const entry = buildApi.current.value?.palette[block.state]
  const name = entry?.Name ?? "minecraft:chest"
  state.error = ""
  state.blockName = pretty(name)
  state.kind = kindOf(name)
  state.tableId = (block.nbt?.LootTable ?? "").replace(/^minecraft:/, "")
  state.table = null
  state.stacks = []
  state.open = true
  try {
    const table = await readLootTable(block.nbt?.LootTable)
    if (!table) {
      state.error = "loot table not found: " + state.tableId
      return
    }
    state.table = table
    await reroll()
  } catch (err) {
    state.error = String(err)
  }
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
// lives in that cell. walking is excluded (pointer lock owns clicks there)
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2()
let downX = 0, downY = 0, downT = 0

function pick(e, canvas) {
  const root = buildApi.getRoot()
  if (!root || state.open) return
  const r = canvas.getBoundingClientRect()
  _ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height * 2 - 1))
  _ray.setFromCamera(_ndc, sceneApi.camera)
  const hit = _ray.intersectObject(root, true).find(h => h.face && h.object.visible)
  if (!hit) return
  const p = hit.point.addScaledVector(hit.face.normal, -1)
  const b = buildApi.blockEntryAt(p.x, p.y, p.z)
  if (b?.nbt?.LootTable) open(b)
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
    pick(e, canvas)
  })
}

export function useContainer() {
  return { state: readonly(state), open, close, reroll, initPicking }
}
