<script setup>
import { computed, nextTick, ref, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "../composables/usePacks.js"
import { useContainer } from "../composables/useContainer.js"
import { useStructure } from "../composables/useStructure.js"
import { useWalk } from "../composables/useWalk.js"
import { useWorld } from "../composables/useWorld.js"
import { getFont, measure, drawText } from "../mcfont.js"
import { drawTooltip, onTooltipFrame, MARGIN } from "../tooltip.js"
import { describeTable, prettyName } from "../loot.js"
import Modal from "./Modal.vue"
import ItemIcon from "./ItemIcon.vue"
import UsedIcon from "./UsedIcon.vue"
import NbtTree from "./NbtTree.vue"

const packs = usePacks()
const container = useContainer()
const state = container.state
const walk = useWalk()
const bgEl = ref(null)
const itemsEl = ref(null)
const hlBackEl = ref(null)
const hlFrontEl = ref(null)
const hoverSlot = ref(-1)
const rendering = ref(false)
const S = 3

const TABS = computed(() => state.dataRows || state.item ? [] : state.table
  ? [
    { id: "loot", label: "Chest" },
    { id: "list", label: "List" },
    { id: "odds", label: "All Items" },
    { id: "rules", label: "Rules" }
  ]
  : state.stacks.length
    ? [{ id: "loot", label: "Chest" }, { id: "list", label: "List" }]
    : [])

const rules = computed(() => state.table ? describeTable(state.table) : [])

const listStacks = computed(() => Array.from(state.stacks).sort((a, b) =>
  b.count - a.count || stackName(a).localeCompare(stackName(b))))

function stackName(s) {
  let n = prettyName(s.id)
  const pot = s.components?.["minecraft:potion_contents"]?.potion
  if (pot) n += " (" + prettyName(pot) + ")"
  return n
}

function fmtPct(c) {
  const p = c * 100
  if (p >= 99.95) return "100%"
  if (p < 0.1) return "<0.1%"
  return p.toFixed(1).replace(/\.0$/, "") + "%"
}

const fmtAvg = v => String(Math.round(v * 10) / 10)

const fmtCount = o => o.min === o.max ? "×" + o.min : `×${o.min}-${o.max} · avg ${fmtAvg(o.avg)}`

function close() {
  container.close()
  walk.resume()
}

const structureApi = useStructure()
function loadPoolStructure(rel) {
  container.close()
  if (walk.state.on) walk.exit()
  structureApi.loadVanilla(rel)
}

const poolLeaf = label => label.startsWith(state.poolId + "/") ? label.slice(state.poolId.length + 1) : label

const facts = computed(() => (state.dataRows ?? []).filter(r => !r.wide))
const wides = computed(() => (state.dataRows ?? []).filter(r => r.wide))

// close on keyup: acting on keydown lets the same held press repeat into the
// walk handlers, and relocking mid-press reads to the browser as an exit gesture
addEventListener("keyup", e => {
  if (e.key === "Escape" && state.open) {
    if (state.item) return container.itemBack()
    container.close()
    walk.resume()
  }
})

function slotAt(ev) {
  const K = state.gui
  if (!K || !itemsEl.value) return -1
  const r = itemsEl.value.getBoundingClientRect()
  const x = (ev.clientX - r.left) / S, y = (ev.clientY - r.top) / S
  const col = Math.floor((x - K.ox) / 18), row = Math.floor((y - K.oy) / 18)
  if (col < 0 || col >= K.cols || row < 0 || row >= K.rows) return -1
  return row * K.cols + col
}

function clickGui(ev) {
  const st = state.stacks.find(s => s.slot === slotAt(ev))
  if (st) {
    hideTip()
    container.openItem(st)
  }
}

const hoverHasStack = computed(() => state.stacks.some(s => s.slot === hoverSlot.value))

// modern items carry components; pre-flattening structures store a tag compound
const itemData = computed(() => {
  const it = state.item
  if (it?.components && Object.keys(it.components).length) return { label: "Components", value: it.components }
  if (it?.tag && Object.keys(it.tag).length) return { label: "NBT", value: it.tag }
  return null
})

const isMapItem = computed(() => /(^|:)filled_map$/.test(state.item?.id ?? ""))

// with the world open, frame maps render the save's real artwork: no stand-in note
const worldApi = useWorld()
const isRealMap = computed(() => {
  const it = state.item
  const n = Number(it?.components?.["minecraft:map_id"] ?? it?.tag?.map)
  return worldApi.state.active && Number.isFinite(n) && worldApi.hasMap(n)
})

let hlImgs = null, hlAssets = null
async function loadHl() {
  const assets = packs.assets.value
  if (hlImgs && hlAssets === assets) return hlImgs
  const lib = await loadLibrary()
  const old = hlImgs
  const onChange = () => { if (hoverSlot.value >= 0) drawHl() }
  const load = name => lib.readTexture(`assets/minecraft/textures/gui/sprites/container/${name}.png`, assets, { onChange })
  hlImgs = { back: await load("slot_highlight_back"), front: await load("slot_highlight_front") }
  hlAssets = assets
  old?.back?.stop?.()
  old?.front?.stop?.()
  return hlImgs
}

function moveGui(ev) {
  const slot = slotAt(ev)
  if (slot !== hoverSlot.value) {
    hoverSlot.value = slot
    drawHl()
  }
  updateTip(ev)
}

function leaveGui() {
  hoverSlot.value = -1
  hideTip()
  drawHl()
}

const tipEl = ref(null)
const tipShow = ref(false)
let tipStack = null, tipX = 0, tipY = 0

function hideTip() {
  tipShow.value = false
  tipStack = null
}

async function updateTip(ev) {
  tipX = ev.clientX
  tipY = ev.clientY
  const stack = state.stacks.find(s => s.slot === hoverSlot.value)
  if (!stack) return hideTip()
  if (stack !== tipStack) {
    tipStack = stack
    tipShow.value = false
    try {
      if (!await drawTooltip(tipEl.value, stack, S)) return
    } catch { return }
    if (stack !== tipStack) return
    tipShow.value = true
  }
  placeTip()
}

onTooltipFrame(async () => {
  if (!tipShow.value || !tipStack || !tipEl.value) return
  try { await drawTooltip(tipEl.value, tipStack, S) } catch {}
})

function placeTip() {
  const c = tipEl.value
  if (!c || !tipShow.value) return
  const m = (3 + MARGIN) * S
  const w = c.width - 2 * m, h = c.height - 2 * m
  let x = tipX + 12 * S
  if (x + w > innerWidth - 4) x = Math.max(tipX - 12 * S - w, 4)
  const y = Math.min(Math.max(tipY - 12 * S, 4), innerHeight - h - 4)
  c.style.left = x - m + "px"
  c.style.top = y - m + "px"
}

async function drawHl() {
  const K = state.gui, bc = hlBackEl.value, fc = hlFrontEl.value
  if (!K || !bc || !fc) return
  bc.width = fc.width = 176 * S
  bc.height = fc.height = bodyH(K) * S
  const slot = hoverSlot.value
  if (slot < 0 || !state.stacks.some(s => s.slot === slot)) return
  const imgs = await loadHl()
  if (slot !== hoverSlot.value) return
  const [ix, iy] = inner(K, slot)
  for (const [c, spr] of [[bc, imgs.back], [fc, imgs.front]]) {
    if (!spr) continue
    const ctx = c.getContext("2d")
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(spr.current, (ix - 4) * S, (iy - 4) * S, 24 * S, 24 * S)
  }
}

const inner = (K, slot) => [K.ox + (slot % K.cols) * 18 + 1, K.oy + (slot / K.cols | 0) * 18 + 1]

// items render on a second stacked canvas so a re-roll never flashes the gui background away
// container section only: cut below the last slot row, plus the texture's 7px bottom border
const bodyH = K => K.oy + K.rows * 18 + 7

let bgSeq = 0
async function drawBg() {
  const c = bgEl.value, K = state.gui
  if (!c || !K) return
  const seq = ++bgSeq
  c.width = 176 * S
  c.height = bodyH(K) * S
  const lib = await loadLibrary()
  const assets = packs.assets.value
  const [bgBuf, font] = await Promise.all([
    lib.readFile(`assets/minecraft/textures/gui/container/${K.tex}.png`, assets),
    getFont()
  ])
  if (seq !== bgSeq || !bgBuf) return
  const img = await createImageBitmap(new Blob([bgBuf], { type: "image/png" }))
  if (seq !== bgSeq) return
  const ctx = c.getContext("2d")
  ctx.imageSmoothingEnabled = false
  // header + slot rows cropped from the full screen texture, closed with its own
  // bottom border strip, so the player inventory half never shows and pack art stays intact
  const cut = K.oy + K.rows * 18
  if (K.tile) {
    const chestH = 17 + Math.min(K.rows, 6) * 18
    ctx.drawImage(img, 0, 0, 176, chestH, 0, 0, 176 * S, chestH * S)
    for (let r = 6; r < K.rows; r++) ctx.drawImage(img, 0, 107, 176, 18, 0, (17 + r * 18) * S, 176 * S, 18 * S)
  } else {
    ctx.drawImage(img, 0, 0, 176, cut, 0, 0, 176 * S, cut * S)
  }
  ctx.drawImage(img, 0, K.texH - 7, 176, 7, 0, cut * S, 176 * S, 7 * S)
  drawText(ctx, font, state.guiTitle, 8 * S, 6 * S, { scale: S, color: "#404040" })
}

let itemSeq = 0
async function drawItems() {
  const c = itemsEl.value, K = state.gui
  if (!c || !K) return
  const seq = ++itemSeq
  rendering.value = true
  try {
    await drawItemsInner(c, K, seq)
  } finally {
    if (seq === itemSeq) rendering.value = false
  }
}

async function drawItemsInner(c, K, seq) {
  c.width = 176 * S
  c.height = bodyH(K) * S
  const lib = await loadLibrary()
  const assets = packs.assets.value
  const font = await getFont()
  if (seq !== itemSeq) return
  const ctx = c.getContext("2d")
  for (const st of state.stacks) {
    if (seq !== itemSeq) return
    const [ix, iy] = inner(K, st.slot)
    try {
      await lib.renderItem({
        id: st.id,
        assets,
        components: st.components ?? {},
        width: 16 * S,
        height: 16 * S,
        canvas: { canvas: c, x: ix * S, y: iy * S, width: 16 * S, height: 16 * S }
      })
    } catch {}
  }
  if (seq !== itemSeq) return
  for (const st of state.stacks) {
    if (st.count <= 1) continue
    const t = String(Math.min(st.count, 999))
    const [ix, iy] = inner(K, st.slot)
    const tx = (ix + 17) * S - measure(font, t) * S, ty = (iy + 9) * S
    drawText(ctx, font, t, tx + S, ty + S, { scale: S, color: "#3f3f3f" })
    drawText(ctx, font, t, tx, ty, { scale: S, color: "#ffffff" })
  }
}

watch(() => [state.open, state.gui, state.guiTitle], () => {
  hoverSlot.value = -1
  hideTip()
  if (state.open) nextTick(drawHl)
  if (state.open) nextTick(drawBg)
})
watch(() => [state.open, state.stacks, state.gui], () => {
  hideTip()
  if (state.open) nextTick(drawItems)
})
</script>

<template>
  <Modal v-if="state.open" :width="584" style="--modal-gap: 12px" @close="close">
    <template #title>
      <h3>{{ state.blockName }}</h3>
      <span class="tid">{{ state.tableId }}</span>
    </template>
      <div v-if="state.error" class="err">{{ state.error }}</div>
      <template v-else>
        <nav class="seg tabs" v-if="TABS.length">
          <button v-for="t in TABS" :key="t.id" :class="{ active: state.tab === t.id }"
            @click="container.setTab(t.id)">{{ t.label }}</button>
        </nav>
        <div class="body" :class="{ compact: state.dataRows || state.pick }">

          <div v-if="state.pick" class="pane picker">
            <button v-for="(p, i) in state.pick" :key="i" class="pick-row" @click="container.openEntity(p.e)">
              <span class="nm">{{ p.label }}</span>
              <span class="material-symbols-outlined">chevron_right</span>
            </button>
          </div>

          <div v-if="state.dataRows" class="pane data">
            <p v-if="state.blurb" class="blurb">{{ state.blurb }}</p>
            <div class="facts" :class="{ two: facts.some(f => f.full) }" v-if="facts.length">
              <div v-for="r in facts" :key="r.label" class="fact" :class="{ full: r.full }">
                <div class="fl">{{ r.label }}</div>
                <div class="fbody">
                  <UsedIcon v-if="r.block" :id="r.block" :blockstates="r.props ?? {}" :size="32" />
                  <div class="fcol">
                    <div class="fv" :class="{ mono: r.mono }">{{ r.value }}</div>
                    <div v-if="r.props" class="fprops">
                      <span v-for="(v, k) in r.props" :key="k" class="fprop"><span class="fpk">{{ k }}</span>{{ v }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div v-for="r in wides" :key="r.label" class="wide-card">
              <div class="fl">{{ r.label }}</div>
              <NbtTree v-if="r.tree" :value="r.tree" />
              <pre v-else>{{ r.value }}</pre>
            </div>
            <div v-if="state.poolId" class="pool-card">
              <div class="ph">
                <button v-if="state.poolStack.length" class="fl phl pback" title="Back to previous pool" @click="container.poolBack()">
                  <span class="material-symbols-outlined">arrow_back</span>
                  Fallback pool
                </button>
                <span v-else class="fl phl">Template pool</span>
                <span class="pid">{{ state.poolId }}</span>
              </div>
              <div v-for="(p, i) in state.poolEntries ?? []" :key="i" class="item-row pe"
                :class="{ clickable: p.clickable }" :title="p.clickable ? 'Load ' + p.label : ''"
                @click="p.clickable && loadPoolStructure(p.rel)">
                <span class="nm mono-nm">{{ poolLeaf(p.label) }}</span>
                <span class="meter"><i :style="{ width: Math.max(p.pct, 1.5) + '%' }"></i></span>
                <span class="pctv">{{ p.pct >= 99.95 ? "100" : p.pct.toFixed(1) }}%</span>
              </div>
              <div v-if="state.poolFallback" class="pfb clickable" title="View the fallback pool"
                @click="container.openFallbackPool()">
                fallback pool: <span class="mono-nm">{{ state.poolFallback }}</span>
                <span class="material-symbols-outlined pfb-arrow">chevron_right</span>
              </div>
            </div>
          </div>

          <div v-if="state.item" class="pane item-view">
            <button class="iback" @click="container.itemBack()">
              <span class="material-symbols-outlined">arrow_back</span>
              Back
            </button>
            <div class="item-row">
              <ItemIcon :id="state.item.id" :components="state.item.components" :size="32" />
              <div class="ittl">
                <span class="nm" :title="stackName(state.item)">{{ stackName(state.item) }}</span>
                <span class="iid">{{ state.item.id.replace(/^minecraft:/, "") }}</span>
              </div>
              <span class="cntv big" v-if="state.item.count > 1">×{{ state.item.count }}</span>
            </div>
            <div v-if="itemData" class="wide-card">
              <div class="fl">{{ itemData.label }}</div>
              <NbtTree :value="itemData.value" />
            </div>
            <div v-else class="empty">No item data.</div>
            <p v-if="isMapItem && state.fromFrame && !isRealMap" class="map-note">
              The shown map previews here are generated stand-ins. Minecraft keeps map artwork in the
              world save, so the real map image is not available in a structure file.
            </p>
          </div>

          <div v-show="state.tab === 'loot' && !state.dataRows && !state.item" class="pane loot">
            <div class="gui" :style="{ cursor: hoverHasStack ? 'pointer' : '' }"
              @click="clickGui" @pointermove="moveGui" @pointerleave="leaveGui">
              <canvas ref="bgEl"></canvas>
              <canvas ref="hlBackEl" class="overlay"></canvas>
              <canvas ref="itemsEl" class="overlay"></canvas>
              <canvas ref="hlFrontEl" class="overlay"></canvas>
            </div>
            <Teleport to="body">
              <canvas ref="tipEl" v-show="tipShow" class="tooltip"></canvas>
            </Teleport>
            <div v-if="state.note" class="note-line">{{ state.note }}</div>
          </div>

          <div v-if="state.tab === 'list' && !state.item" class="pane">
            <div v-if="!listStacks.length" class="empty">Empty.</div>
            <div v-for="(s, i) in listStacks" :key="i" class="item-row clickable" @click="container.openItem(s)">
              <ItemIcon :id="s.id" :components="s.components" :size="32" />
              <span class="nm" :title="stackName(s)">{{ stackName(s) }}</span>
              <span class="cntv big">×{{ s.count }}</span>
            </div>
          </div>

          <div v-if="state.tab === 'odds' && !state.item" class="pane">
            <div v-if="state.oddsBusy" class="empty">Measuring drop rates over 10,000 opens…</div>
            <div v-else-if="state.odds && !state.odds.length" class="empty">This table never drops anything.</div>
            <template v-else-if="state.odds">
              <div class="cols"><span class="nm">Item · most common first</span><span class="chance-h">Chance</span><span class="cnt-h">Amount</span></div>
              <div v-for="o in state.odds" :key="o.id + JSON.stringify(o.components ?? null)" class="item-row clickable" @click="container.openItem(o)">
                <ItemIcon :id="o.id" :components="o.components" :size="32" />
                <span class="nm" :title="stackName(o)">{{ stackName(o) }}</span>
                <span class="meter"><i :style="{ width: Math.max(o.chance * 100, 1.5) + '%' }"></i></span>
                <span class="pctv">{{ fmtPct(o.chance) }}</span>
                <span class="cntv">{{ fmtCount(o) }}</span>
              </div>
            </template>
          </div>

          <div v-if="state.tab === 'rules' && !state.item" class="pane rules">
            <div v-for="(pool, pi) in rules" :key="pi" class="pool">
              <div class="pool-head">
                Pool {{ pi + 1 }} · {{ pool.rolls }} roll{{ pool.rolls === "1" ? "" : "s" }}<template v-if="pool.bonus"> (+{{ pool.bonus }} bonus)</template><template v-if="pool.chance"> · {{ pool.chance }}</template>
              </div>
              <div v-for="(en, ei) in pool.entries" :key="ei" class="entry">
                <span class="meter"><i :style="{ width: Math.max(en.pct, 1.5) + '%' }"></i></span>
                <span class="pctv">{{ en.pct }}%</span>
                <span class="nm">{{ en.name }}<span v-if="en.note" class="note"> · {{ en.note }}</span></span>
                <span class="cnt">{{ en.count ? "×" + en.count : "" }}</span>
              </div>
            </div>
          </div>

        </div>
        <div class="actions" v-if="state.table && !state.item && (state.tab === 'loot' || state.tab === 'list')">
          <button :disabled="rendering" @click="container.reroll()">
            <span class="material-symbols-outlined">shuffle</span>
            Re-roll
          </button>
          <span class="roll-stats" v-if="state.rolls > 1">
            {{ state.rolls.toLocaleString("en") }} opens · {{ state.pileTotal.toLocaleString("en") }} item{{ state.pileTotal === 1 ? "" : "s" }}
          </span>
          <span v-else></span>
          <div class="right">
            <button :disabled="rendering" @click="container.addRoll()">
              <span class="material-symbols-outlined">shuffle</span>
              Add Roll
            </button>
            <button :disabled="rendering" title="Add 100 rolls" @click="container.addRoll(100)">
              +100
            </button>
          </div>
        </div>
      </template>
  </Modal>
</template>

<style scoped>
.tid {
  font-size: 12px;
  color: var(--text-dim);
  font-family: ui-monospace, monospace;
}

.pane.data { gap: 8px; }

.blurb {
  margin: 0 2px 6px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.55;
}

.fl {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}

.facts.two { grid-template-columns: 1fr 1fr; }
.fact.full { grid-column: 1 / -1; }

.fact {
  background: #ffffff05;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
}

.fact .fbody {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 3px;
}

.fact .fcol { min-width: 0; }

.fact .fv {
  overflow-wrap: anywhere;
}

.fact .fv.mono, .mono-nm {
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
}

.fact .fprops { margin-top: 6px; }

.wide-card {
  background: #ffffff05;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
}

.wide-card pre {
  margin: 4px 0 0;
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.pool-card {
  background: #ffffff05;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.pool-card .ph {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.pool-card .pid {
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
  overflow-wrap: anywhere;
  text-align: right;
}

.pool-card .pe {
  padding: 5px 10px;
  border-radius: 0;
}

.pool-card .pe.clickable { cursor: pointer; }
.pool-card .pe.clickable:hover { background: #ffffff0d; }
.pool-card .pe.clickable:hover .nm { color: var(--accent); }

.pool-card .pfb {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
}

.pool-card .pfb.clickable { cursor: pointer; }
.pool-card .pfb.clickable:hover { background: #ffffff0d; color: var(--text); }

.pfb-arrow {
  font-size: 16px;
  margin-left: auto;
}

.phl {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pback {
  background: transparent;
  border: none;
  padding: 0;
  display: flex;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
}

.pback:hover { color: var(--text); background: transparent; }
.pback .material-symbols-outlined { font-size: 16px; }

.pane {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pane.loot {
  gap: 12px;
  padding-top: 6px;
}

.item-row.clickable { cursor: pointer; }
.item-row.clickable:hover .nm { color: var(--accent); }

.pane.item-view { gap: 8px; }

.iback {
  background: transparent;
  border: none;
  padding: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  width: fit-content;
}

.iback:hover { color: var(--text); background: transparent; }
.iback .material-symbols-outlined { font-size: 16px; }

.ittl {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.iid {
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
  color: var(--text-dim);
}

.map-note {
  margin: 0;
  padding: 8px 10px;
  border: 1px dashed #d9a13f;
  border-radius: 8px;
  background: #d9a13f14;
  color: #e5c07b;
  font-size: 12px;
  line-height: 1.5;
}

.gui {
  position: relative;
  width: fit-content;
  margin: 0 auto;
}

.gui canvas { display: block; }

.gui .overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.tooltip {
  position: fixed;
  z-index: 1000;
  pointer-events: none;
}

.actions {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
}

.actions button {
  display: flex;
  align-items: center;
  gap: 6px;
}

.actions > button { justify-self: start; }

.actions .right {
  justify-self: end;
  display: flex;
  gap: 6px;
}

.roll-stats {
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
}

.actions .material-symbols-outlined { font-size: 18px; }

.err { color: var(--red); font-size: 13px; }

.note-line {
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
}

.empty {
  color: var(--text-dim);
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}

.cols {
  display: flex;
  gap: 10px;
  padding: 2px 6px 6px;
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.cols .chance-h { width: 118px; text-align: right; flex-shrink: 0; }
.cols .cnt-h { width: 118px; text-align: right; flex-shrink: 0; }

.note { opacity: 0.7; }

.meter {
  width: 64px;
  height: 6px;
  border-radius: 3px;
  background: #ffffff14;
  overflow: hidden;
  flex-shrink: 0;
}

.meter i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
}

.pctv {
  width: 48px;
  text-align: right;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  flex-shrink: 0;
}

.cntv {
  width: 118px;
  text-align: right;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--text-dim);
  flex-shrink: 0;
  white-space: nowrap;
}

.cntv.big {
  width: auto;
  font-size: 13px;
  color: var(--text);
}

.rules { gap: 10px; }

.pool {
  background: #ffffff05;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
}

.pool-head {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 6px;
}

.entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  color: var(--text-dim);
  font-family: ui-monospace, monospace;
  font-size: 12px;
}

.entry .nm { flex: 1; }
.entry .cnt { flex-shrink: 0; }

.picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pick-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  padding: 8px 12px;
}

.pick-row .material-symbols-outlined {
  font-size: 18px;
  color: var(--text-dim);
}
</style>
