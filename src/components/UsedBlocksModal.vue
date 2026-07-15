<script setup>
import { computed, reactive, watch, onMounted, onBeforeUnmount } from "vue"
import { useBuild } from "../composables/useBuild.js"
import { useContainer } from "../composables/useContainer.js"
import { isInspectable } from "../loot.js"
import UsedIcon from "./UsedIcon.vue"

const AIR = /(^|:)(air|cave_air|void_air|structure_void)$/
const build = useBuild()
const container = useContainer()

const state = reactive({
  open: false,
  tab: "blocks",
  sort: "count",
  expanded: {},
  expandedState: {},
  data: null
})

const stripNs = id => id.replace(/^minecraft:/, "")
const isDataName = name => isInspectable(name) || /(^|[:_])spawner$/.test(stripNs(name))

function compute() {
  const s = build.current.value
  if (!s) return null
  const groups = new Map()
  let total = 0
  for (const b of s.blocks) {
    const e = s.palette[b.state]
    if (!e?.Name || AIR.test(e.Name)) continue
    total++
    let g = groups.get(e.Name)
    if (!g) groups.set(e.Name, g = { id: e.Name, count: 0, states: new Map() })
    g.count++
    const key = JSON.stringify(e.Properties ?? null)
    let st = g.states.get(key)
    if (!st) g.states.set(key, st = { props: e.Properties ?? null, count: 0, blocks: null })
    st.count++
    if (isDataName(e.Name) || b.nbt?.LootTable) (st.blocks ??= []).push(b)
  }
  const blocks = Array.from(groups.values(), g => ({
    id: g.id,
    count: g.count,
    states: Array.from(g.states.values()).sort((a, b) => b.count - a.count)
  }))
  // most-varying properties lead each row, so a constant waterlogged=false trails
  for (const g of blocks) {
    const values = new Map()
    for (const st of g.states) for (const k of Object.keys(st.props ?? {})) {
      if (!values.has(k)) values.set(k, new Set())
    }
    for (const [k, set] of values) for (const st of g.states) set.add(st.props?.[k] ?? "\0")
    const order = Array.from(values.keys()).sort((a, b) => values.get(b).size - values.get(a).size || a.localeCompare(b))
    for (const st of g.states) {
      st.label = st.props ? order.filter(k => k in st.props).map(k => `${k}=${st.props[k]}`).join(", ") : "default"
    }
  }

  const entities = new Map()
  for (const e of s.entities ?? []) {
    const id = e.nbt?.id
    if (typeof id !== "string") continue
    let g = entities.get(id)
    if (!entities.has(id)) entities.set(id, g = { id, count: 0, list: [] })
    g.count++
    g.list.push(e)
  }
  const entityKey = e => {
    const { Pos, UUID, TileX, TileY, TileZ, ...rest } = e.nbt ?? {}
    return JSON.stringify(rest)
  }
  const entityGroups = Array.from(entities.values(), g => ({
    ...g,
    allSame: g.list.every(e => entityKey(e) === entityKey(g.list[0]))
  }))

  return { total, blocks, entities: entityGroups }
}

const blockRows = computed(() => {
  const d = state.data
  if (!d) return []
  const rows = d.blocks.slice()
  rows.sort(state.sort === "count"
    ? (a, b) => b.count - a.count || stripNs(a.id).localeCompare(stripNs(b.id))
    : (a, b) => stripNs(a.id).localeCompare(stripNs(b.id)))
  return rows
})

const entityRows = computed(() => {
  const d = state.data
  if (!d) return []
  const rows = d.entities.slice()
  rows.sort(state.sort === "count"
    ? (a, b) => b.count - a.count || stripNs(a.id).localeCompare(stripNs(b.id))
    : (a, b) => stripNs(a.id).localeCompare(stripNs(b.id)))
  return rows
})

function fmtPct(n) {
  const p = n / (state.data?.total || 1) * 100
  if (p >= 99.95) return "100%"
  if (p < 0.1) return "<0.1%"
  return p.toFixed(1).replace(/\.0$/, "") + "%"
}

const posText = pos => pos.map(v => Math.round(v * 100) / 100).join(", ")

function expandable(g) {
  return g.states.length > 1 || g.states[0].props || hasData(g.states[0])
}

const hasData = st => !!st.blocks?.length
const sameData = st => st.blocks.every(b => JSON.stringify(b.nbt ?? null) === JSON.stringify(st.blocks[0].nbt ?? null))

function clickBlock(g) {
  if (!expandable(g)) return
  state.expanded[g.id] = !state.expanded[g.id]
}

function clickState(g, st) {
  if (!hasData(st)) return
  if (sameData(st)) return container.open(st.blocks[0])
  const key = g.id + "|" + JSON.stringify(st.props)
  state.expandedState[key] = !state.expandedState[key]
}

function clickEntity(g) {
  if (g.allSame) return container.openEntity(g.list[0])
  state.expanded["e:" + g.id] = !state.expanded["e:" + g.id]
}

function open() {
  state.tab = "blocks"
  state.expanded = {}
  state.expandedState = {}
  state.data = compute()
  state.open = true
}

function close() {
  state.open = false
  state.data = null
}

watch(build.current, () => {
  if (state.open) state.data = compute()
})

function onKey(e) {
  if (e.key === "Escape" && state.open && !container.state.open) close()
}
onMounted(() => addEventListener("keydown", onKey))
onBeforeUnmount(() => removeEventListener("keydown", onKey))

defineExpose({ open })
</script>

<template>
  <div v-if="state.open" class="ub-backdrop" @pointerdown.self="close">
    <div class="ub-panel">
      <header>
        <h3>Used blocks</h3>
        <div class="controls">
          <div class="seg">
            <button :class="{ active: state.sort === 'count' }" @click="state.sort = 'count'">Most common</button>
            <button :class="{ active: state.sort === 'abc' }" @click="state.sort = 'abc'">A–Z</button>
          </div>
          <button class="icon" @click="close" aria-label="Close">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </header>
      <div class="seg tabs" v-if="state.data?.entities.length">
        <button :class="{ active: state.tab === 'blocks' }" @click="state.tab = 'blocks'">Blocks ({{ state.data.blocks.length }})</button>
        <button :class="{ active: state.tab === 'entities' }" @click="state.tab = 'entities'">Entities ({{ state.data.entities.length }})</button>
      </div>

      <div class="body" v-if="state.tab === 'blocks'">
        <template v-for="g in blockRows" :key="g.id">
          <div class="row" :class="{ click: expandable(g) }" @click="clickBlock(g)">
            <span class="material-symbols-outlined chev" :class="{ hidden: !expandable(g), open: state.expanded[g.id] }">chevron_right</span>
            <UsedIcon :id="g.id" :blockstates="g.states[0].props ?? {}" :size="32" />
            <span class="name">{{ stripNs(g.id) }}</span>
            <span class="count">×{{ g.count }}<small>{{ fmtPct(g.count) }}</small></span>
          </div>
          <template v-if="state.expanded[g.id]">
            <template v-for="st in g.states" :key="JSON.stringify(st.props)">
              <div class="row sub" :class="{ click: hasData(st) }" @click="clickState(g, st)">
                <UsedIcon :id="g.id" :blockstates="st.props ?? {}" :size="32" />
                <span class="name mono">{{ st.label }}</span>
                <span v-if="hasData(st)" class="material-symbols-outlined data">{{ sameData(st) ? "open_in_new" : "unfold_more" }}</span>
                <span class="count">×{{ st.count }}<small>{{ fmtPct(st.count) }}</small></span>
              </div>
              <template v-if="hasData(st) && !sameData(st) && state.expandedState[g.id + '|' + JSON.stringify(st.props)]">
                <div v-for="(b, i) in st.blocks" :key="i" class="row sub2 click" @click="container.open(b)">
                  <span class="name mono">{{ posText(b.pos) }}</span>
                  <span class="material-symbols-outlined data">open_in_new</span>
                </div>
              </template>
            </template>
          </template>
        </template>
      </div>

      <div class="body" v-else>
        <template v-for="g in entityRows" :key="g.id">
          <div class="row click" @click="clickEntity(g)">
            <span class="material-symbols-outlined chev" :class="{ hidden: g.allSame, open: state.expanded['e:' + g.id] }">chevron_right</span>
            <UsedIcon kind="entity" :id="g.id" :size="32" />
            <span class="name">{{ stripNs(g.id) }}</span>
            <span v-if="g.allSame" class="material-symbols-outlined data">open_in_new</span>
            <span class="count">×{{ g.count }}</span>
          </div>
          <template v-if="!g.allSame && state.expanded['e:' + g.id]">
            <div v-for="(e, i) in g.list" :key="i" class="row sub click" @click="container.openEntity(e)">
              <span class="name mono">{{ posText(e.pos) }}</span>
              <span class="material-symbols-outlined data">open_in_new</span>
            </div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ub-backdrop {
  position: fixed;
  inset: 0;
  background: #00000080;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 90;
}

.ub-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 460px;
  max-width: calc(100vw - 32px);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

button.icon {
  display: flex;
  align-items: center;
  padding: 4px;
}

.seg {
  display: flex;
  gap: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px;
}

.seg button {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px 10px;
  color: var(--text-dim);
  font-size: 12.5px;
}

.seg.tabs button { flex: 1; }

.seg button:hover:not(.active) {
  background: #ffffff0a;
  color: var(--text);
}

.seg button.active {
  background: var(--panel-2);
  border-color: var(--border);
  color: var(--text);
}

.body {
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 13px;
  user-select: none;
}

.row.click { cursor: pointer; }
.row.click:hover { background: #ffffff0a; }

.row.sub { padding-left: 40px; }
.row.sub2 { padding-left: 76px; }

.chev {
  font-size: 18px;
  color: var(--text-dim);
  transition: transform 0.12s;
  flex-shrink: 0;
}

.chev.hidden { visibility: hidden; }
.chev.open { transform: rotate(90deg); }

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name.mono {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--text-dim);
}

.count {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-shrink: 0;
}

.count small {
  color: var(--text-dim);
  font-size: 11px;
  min-width: 42px;
  text-align: right;
}

.data {
  font-size: 15px;
  color: var(--text-dim);
  flex-shrink: 0;
}
</style>
