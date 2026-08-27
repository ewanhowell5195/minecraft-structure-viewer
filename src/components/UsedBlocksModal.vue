<script setup>
import { computed, reactive, watch, onMounted, onBeforeUnmount } from "vue"
import { useBuild } from "../composables/useBuild.js"
import { useCompare } from "../composables/useCompare.js"
import { useContainer } from "../composables/useContainer.js"
import { useFind } from "../composables/useFind.js"
import { isInspectable } from "../loot.js"
import Modal from "./Modal.vue"
import Seg from "./Seg.vue"
import UsedIcon from "./UsedIcon.vue"

const AIR = /(^|:)(air|cave_air|void_air|structure_void)$/
const build = useBuild()
const compare = useCompare()
const container = useContainer()
const find = useFind()

const state = reactive({
  open: false,
  tab: "blocks",
  sort: "count",
  expanded: {},
  expandedState: {},
  data: null
})

const stripNs = id => id.replace(/^minecraft:/, "")
const json = v => JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() + "n" : x)
const isDataName = name => isInspectable(name) || /(^|[:_])spawner$/.test(stripNs(name))

// waterlogged=false is hidden, so strip it before keying or its states would duplicate
function shownProps(props) {
  if (props?.waterlogged !== "false") return props ?? null
  const { waterlogged, ...rest } = props
  return Object.keys(rest).length ? rest : null
}

function compute() {
  const s = build.current.value
  if (!s) return null
  const groups = new Map()
  let total = 0
  for (const b of s.blocks) {
    const e = s.palette[b.state]
    if (!e?.id || AIR.test(e.id)) continue
    total++
    let g = groups.get(e.id)
    if (!g) groups.set(e.id, g = { id: e.id, count: 0, states: new Map() })
    g.count++
    const props = shownProps(e.properties)
    const key = JSON.stringify(props)
    let st = g.states.get(key)
    if (!st) g.states.set(key, st = { props, count: 0, blocks: null })
    st.count++
    if (isDataName(e.id) || b.nbt?.LootTable) (st.blocks ??= []).push(b)
  }
  const blocks = Array.from(groups.values(), g => ({
    id: g.id,
    count: g.count,
    states: Array.from(g.states.values()).sort((a, b) => b.count - a.count)
  }))
  // most-varying properties lead each row
  for (const g of blocks) {
    const values = new Map()
    for (const st of g.states) for (const k of Object.keys(st.props ?? {})) {
      if (!values.has(k)) values.set(k, new Set())
    }
    for (const [k, set] of values) for (const st of g.states) set.add(st.props?.[k] ?? "\0")
    const order = Array.from(values.keys()).sort((a, b) => values.get(b).size - values.get(a).size || a.localeCompare(b))
    for (const st of g.states) {
      st.entries = st.props ? order.filter(k => k in st.props).map(k => [k, st.props[k]]) : null
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
    return json(rest)
  }
  const entityGroups = Array.from(entities.values(), g => ({
    ...g,
    allSame: g.list.every(e => entityKey(e) === entityKey(g.list[0]))
  }))

  return { total, blocks, entities: entityGroups }
}

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

function computeCompare() {
  const leftStruct = compare.leftStructure()
  const rightStruct = build.current.value
  const left = sideCounts(leftStruct)
  const right = sideCounts(rightStruct)
  return {
    compare: true,
    blocks: mergeCounts(left.blocks, right.blocks),
    entities: mergeCounts(left.entities, right.entities),
    changed: pairChanges(leftStruct, rightStruct)
  }
}

const pairOpens = p => p.nbt
const propsText = p => p.props.map(d => `${d.k} ${d.l}→${d.r}`).join("  ")

function clickChanged(g, kind) {
  if (g.pairs.length === 1 && pairOpens(g.pairs[0]) && !g.pairs[0].props.length) return openPair(g.pairs[0], kind)
  state.expanded["c:" + kind + g.id] = !state.expanded["c:" + kind + g.id]
}

function openPair(p, kind) {
  if (kind === "entity") return container.openCompareEntity(p.left, p.right)
  container.openCompare(p.left, p.right)
}

const computeData = () => compare.state.on ? computeCompare() : compute()

const countSort = compare => compare
  ? (a, b) => b.delta - a.delta || stripNs(a.id).localeCompare(stripNs(b.id))
  : (a, b) => b.count - a.count || stripNs(a.id).localeCompare(stripNs(b.id))
const abcSort = (a, b) => stripNs(a.id).localeCompare(stripNs(b.id))

const blockRows = computed(() => {
  const d = state.data
  if (!d) return []
  return d.blocks.slice().sort(state.sort === "count" ? countSort(d.compare) : abcSort)
})

const entityRows = computed(() => {
  const d = state.data
  if (!d) return []
  return d.entities.slice().sort(state.sort === "count" ? countSort(d.compare) : abcSort)
})

const anyBlockExpandable = computed(() => !state.data?.compare && blockRows.value.some(expandable))
const anyEntityExpandable = computed(() => !state.data?.compare && entityRows.value.some(g => !g.allSame))

const sortsDiffer = computed(() => {
  const d = state.data
  if (!d) return false
  const rows = state.tab === "blocks" ? d.blocks : d.entities
  const abc = rows.slice().sort(abcSort)
  const count = rows.slice().sort(countSort(d.compare))
  return count.some((r, i) => r.id !== abc[i].id)
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
const sameData = st => st.blocks.every(b => json(b.nbt ?? null) === json(st.blocks[0].nbt ?? null))

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

function findBlocks(id, props, entries) {
  const s = build.current.value
  if (!s) return
  const key = props === undefined ? null : JSON.stringify(props)
  const hits = []
  for (const b of s.blocks) {
    const e = s.palette[b.state]
    if (e?.id !== id) continue
    if (key !== null && JSON.stringify(shownProps(e.properties)) !== key) continue
    hits.push(b)
  }
  if (!hits.length) return
  const text = props ? (entries ?? Object.entries(props)).map(([k, v]) => `${k}=${v}`).join(" ") : ""
  find.start(hits, text ? `${stripNs(id)} ${text}` : stripNs(id), b => build.boxForBlock(b))
  close()
}

function itemOf(g) {
  if (stripNs(g.id) !== "item") return null
  const first = g.list[0]?.nbt?.Item
  if (!first?.id) return null
  const key = json(first)
  return g.list.every(e => json(e.nbt?.Item) === key) ? first : null
}

function findEntities(g) {
  find.start(g.list, stripNs(g.id), e => build.boxForEntityData(e))
  close()
}

function clickEntity(g) {
  if (g.allSame) return container.openEntity(g.list[0])
  state.expanded["e:" + g.id] = !state.expanded["e:" + g.id]
}

function open() {
  state.expanded = {}
  state.expandedState = {}
  state.data = computeData()
  state.tab = tabBlocks(state.data) || !tabEnts(state.data) ? "blocks" : "entities"
  state.open = true
}

function close() {
  state.open = false
  state.data = null
  container.refreshHover()
}

watch([build.current, () => compare.state.on], () => {
  if (state.open) state.data = computeData()
})

const deltaText = g => g.delta > 0 ? `+${g.delta}` : g.delta < 0 ? `${g.delta}` : ""

const tabBlocks = d => d ? d.blocks.length + (d.changed?.blocks.length ?? 0) : 0
const tabEnts = d => d ? d.entities.length + (d.changed?.entities.length ?? 0) : 0

const sortTabs = computed(() => [
  { id: "count", label: state.data?.compare ? "Biggest change" : "Most common" },
  { id: "abc", label: "A–Z" }
])
const kindTabs = computed(() => [
  { id: "blocks", label: `Blocks (${tabBlocks(state.data)})` },
  { id: "entities", label: `Entities (${tabEnts(state.data)})` }
])

function onKey(e) {
  if (e.key === "Escape" && state.open && !container.state.open) close()
}
onMounted(() => addEventListener("keydown", onKey))
onBeforeUnmount(() => removeEventListener("keydown", onKey))

defineExpose({ open })
</script>

<template>
  <Modal v-if="state.open" :width="584" :z="90" @close="close">
    <template #title>
      <h3 v-if="state.data?.compare">{{ tabBlocks(state.data) || !tabEnts(state.data) ? "Block changes" : "Entity changes" }}</h3>
      <h3 v-else>{{ tabBlocks(state.data) || !tabEnts(state.data) ? "Used blocks" : "Used entities" }}</h3>
    </template>
    <template #controls>
      <Seg :class="{ ghost: !sortsDiffer }" :tabs="sortTabs" v-model="state.sort" />
    </template>
    <Seg v-if="tabEnts(state.data) && tabBlocks(state.data)" class="tabs" :tabs="kindTabs" v-model="state.tab" />

    <div class="body" v-if="state.data?.compare && state.tab === 'blocks'">
      <div v-if="!tabBlocks(state.data)" class="line row empty">No block changes</div>
      <div v-for="g in blockRows" :key="g.id" class="item-row group">
        <div class="line row">
          <UsedIcon :id="g.id" :size="32" />
          <span class="nm">{{ stripNs(g.id) }}</span>
          <span class="count">×{{ g.left }}<span class="arr">→</span>×{{ g.right }}<small class="delta" :class="{ pos: g.delta > 0, neg: g.delta < 0 }">{{ deltaText(g) }}</small></span>
        </div>
      </div>
      <div v-for="g in state.data.changed.blocks" :key="'c:' + g.id" class="item-row group">
        <div class="line row click" @click="clickChanged(g, 'block')">
          <UsedIcon :id="g.id" :size="32" />
          <span class="nm">{{ stripNs(g.id) }}</span>
          <span v-if="g.pairs.length === 1 && g.pairs[0].nbt && !g.pairs[0].props.length" class="material-symbols-outlined data">open_in_new</span>
          <span class="count"><small class="delta chg">{{ g.pairs.length === 1 ? "changed" : g.pairs.length + " changed" }}</small></span>
          <span class="material-symbols-outlined chev" :class="{ hidden: g.pairs.length === 1 && g.pairs[0].nbt && !g.pairs[0].props.length, open: state.expanded['c:block' + g.id] }">chevron_right</span>
        </div>
        <template v-if="state.expanded['c:block' + g.id]">
          <div v-for="(p, i) in g.pairs" :key="i" class="line row sub" :class="{ click: p.nbt }" @click="p.nbt && openPair(p, 'block')">
            <span class="nm mono">{{ posText(p.right.pos) }}</span>
            <span v-if="p.props.length" class="nm mono">{{ propsText(p) }}</span>
            <span v-if="p.nbt" class="material-symbols-outlined data">open_in_new</span>
          </div>
        </template>
      </div>
    </div>

    <div class="body" v-else-if="state.data?.compare">
      <div v-if="!tabEnts(state.data)" class="line row empty">No entity changes</div>
      <div v-for="g in entityRows" :key="g.id" class="item-row group">
        <div class="line row">
          <UsedIcon kind="entity" :id="g.id" :size="32" />
          <span class="nm">{{ stripNs(g.id) }}</span>
          <span class="count">×{{ g.left }}<span class="arr">→</span>×{{ g.right }}<small class="delta" :class="{ pos: g.delta > 0, neg: g.delta < 0 }">{{ deltaText(g) }}</small></span>
        </div>
      </div>
      <div v-for="g in state.data.changed.entities" :key="'c:' + g.id" class="item-row group">
        <div class="line row click" @click="clickChanged(g, 'entity')">
          <UsedIcon kind="entity" :id="g.id" :size="32" />
          <span class="nm">{{ stripNs(g.id) }}</span>
          <span v-if="g.pairs.length === 1" class="material-symbols-outlined data">open_in_new</span>
          <span class="count"><small class="delta chg">{{ g.pairs.length === 1 ? "changed" : g.pairs.length + " changed" }}</small></span>
          <span class="material-symbols-outlined chev" :class="{ hidden: g.pairs.length === 1, open: state.expanded['c:entity' + g.id] }">chevron_right</span>
        </div>
        <template v-if="g.pairs.length > 1 && state.expanded['c:entity' + g.id]">
          <div v-for="(p, i) in g.pairs" :key="i" class="line row sub click" @click="openPair(p, 'entity')">
            <span class="nm mono">{{ posText(p.right.pos) }}</span>
            <span class="material-symbols-outlined data">open_in_new</span>
          </div>
        </template>
      </div>
    </div>

    <div class="body" v-else-if="state.tab === 'blocks'">
      <div v-for="g in blockRows" :key="g.id" class="item-row group">
        <div class="line row" :class="{ click: expandable(g) }" @click="clickBlock(g)">
          <UsedIcon :id="g.id" :size="32" />
          <span class="nm">{{ stripNs(g.id) }}</span>
          <button class="find" title="Find in scene" @click.stop="findBlocks(g.id)">
            <span class="material-symbols-outlined">my_location</span>
          </button>
          <span class="count">×{{ g.count }}<small>{{ fmtPct(g.count) }}</small></span>
          <span v-if="anyBlockExpandable" class="material-symbols-outlined chev" :class="{ hidden: !expandable(g), open: state.expanded[g.id] }">chevron_right</span>
        </div>
        <template v-if="state.expanded[g.id]">
          <template v-for="st in g.states" :key="JSON.stringify(st.props)">
            <div class="line row sub" :class="{ click: hasData(st), reserve: anyBlockExpandable }" @click="clickState(g, st)">
              <UsedIcon :id="g.id" :blockstates="st.props ?? {}" :size="32" />
              <span v-if="st.entries?.length" class="nm fprops">
                <span v-for="[k, v] in st.entries" :key="k" class="fprop"><span class="fpk">{{ k }}</span>{{ v }}</span>
              </span>
              <span v-else class="nm mono">default</span>
              <span v-if="hasData(st)" class="material-symbols-outlined data">{{ sameData(st) ? "open_in_new" : "unfold_more" }}</span>
              <button class="find" title="Find in scene" @click.stop="findBlocks(g.id, st.props, st.entries)">
                <span class="material-symbols-outlined">my_location</span>
              </button>
              <span class="count">×{{ st.count }}<small>{{ fmtPct(st.count) }}</small></span>
            </div>
            <template v-if="hasData(st) && !sameData(st) && state.expandedState[g.id + '|' + JSON.stringify(st.props)]">
              <div v-for="(b, i) in st.blocks" :key="i" class="line row sub2 click" :class="{ reserve: anyBlockExpandable }" @click="container.open(b)">
                <span class="nm mono">{{ posText(b.pos) }}</span>
                <span class="material-symbols-outlined data">open_in_new</span>
              </div>
            </template>
          </template>
        </template>
      </div>
    </div>

    <div class="body" v-else>
      <div v-for="g in entityRows" :key="g.id" class="item-row group">
        <div class="line row click" @click="clickEntity(g)">
          <UsedIcon v-if="itemOf(g)" kind="item" :id="itemOf(g).id" :components="itemOf(g).components" :size="32" />
          <UsedIcon v-else kind="entity" :id="g.id" :size="32" />
          <span class="nm">{{ stripNs(g.id) }}</span>
          <span v-if="g.allSame" class="material-symbols-outlined data">open_in_new</span>
          <button class="find" title="Find in scene" @click.stop="findEntities(g)">
            <span class="material-symbols-outlined">my_location</span>
          </button>
          <span class="count">×{{ g.count }}</span>
          <span v-if="anyEntityExpandable" class="material-symbols-outlined chev" :class="{ hidden: g.allSame, open: state.expanded['e:' + g.id] }">chevron_right</span>
        </div>
        <template v-if="!g.allSame && state.expanded['e:' + g.id]">
          <div v-for="(e, i) in g.list" :key="i" class="line row sub click" :class="{ reserve: anyEntityExpandable }" @click="container.openEntity(e)">
            <span class="nm mono">{{ posText(e.pos) }}</span>
            <span class="material-symbols-outlined data">open_in_new</span>
          </div>
        </template>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
/* matches the 30px close button so hiding the seg never shifts the header */
.controls .seg { height: 30px; }

.controls .seg button {
  display: flex;
  align-items: center;
  padding: 0 10px;
}

/* hidden, not removed, so the header keeps its height */
.seg.ghost { visibility: hidden; }

.body {
  display: flex;
  flex-direction: column;
}

.item-row.group {
  display: block;
  padding: 0;
}

.line {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 6px;
  border-radius: 6px;
}

.row {
  font-size: 13px;
  user-select: none;
}

.row.click { cursor: pointer; }
.row.click:not(.sub):not(.sub2):hover { background: #ffffff0a; }

.row.click:hover .nm:not(.fprops) { color: var(--accent); }

.row.click:hover .chev,
.row.click:hover .data { color: var(--text); }

/* margins, not padding, so dividers span only the content; levels step by icon + half gap */
.row.sub {
  margin-left: 43px;
  margin-right: 6px;
  padding-left: 0;
  padding-right: 0;
  border-top: 1px solid var(--border);
  border-radius: 0;
}

.row.sub2 {
  margin-left: 80px;
  margin-right: 6px;
  padding-left: 0;
  padding-right: 0;
}

.nm.fprops { padding: 6px 0; }

.chev {
  font-size: 18px;
  color: var(--text-dim);
  transition: transform 0.12s;
  flex-shrink: 0;
}

.chev.hidden { visibility: hidden; }
.chev.open { transform: rotate(90deg); }

/* reserves the chevron column */
.row.reserve {
  margin-right: 29px;
  padding-right: 5px;
}

.nm.mono {
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

.count .arr {
  color: var(--text-dim);
  margin: 0 6px;
}

.count .delta.pos { color: #6fd487; }
.count .delta.neg { color: #ff6b82; }
.count .delta.chg { color: #f0c85a; min-width: 0; }

.row.empty { color: var(--text-dim); }

.data {
  font-size: 15px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.find {
  display: flex;
  padding: 3px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.find:hover:not(:disabled) {
  background: #ffffff14;
  color: var(--text);
}

.find .material-symbols-outlined { font-size: 16px; }
</style>
