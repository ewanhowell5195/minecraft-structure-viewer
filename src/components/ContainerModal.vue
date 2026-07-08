<script setup>
import { computed, nextTick, ref, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "../composables/usePacks.js"
import { useContainer } from "../composables/useContainer.js"
import { useStructure } from "../composables/useStructure.js"
import { useWalk } from "../composables/useWalk.js"
import { getFont, measure, drawText } from "../mcfont.js"
import { describeTable, prettyName } from "../loot.js"
import ItemIcon from "./ItemIcon.vue"

const packs = usePacks()
const container = useContainer()
const state = container.state
const walk = useWalk()
const bgEl = ref(null)
const itemsEl = ref(null)
const rendering = ref(false)
const S = 3

const TABS = computed(() => state.dataRows ? [] : state.table
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

// the list tab mirrors the chest contents as text, biggest stacks first
const listStacks = computed(() => [...state.stacks].sort((a, b) =>
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

// "how many you'd get" column: exact count, or the range with its average
const fmtCount = o => o.min === o.max ? "×" + o.min : `×${o.min}-${o.max} · avg ${fmtAvg(o.avg)}`

function close() {
  container.close()
  walk.resume() // no-op unless a walk session is waiting behind the modal
}

// clicking a pool entry loads that structure (leaving any walk session,
// since the scene it belonged to is being replaced)
const structureApi = useStructure()
function loadPoolStructure(rel) {
  container.close()
  if (walk.state.on) walk.exit()
  structureApi.loadVanilla(rel)
}

// entries usually live inside the pool's folder: show just what differs
const poolLeaf = label => label.startsWith(state.poolId + "/") ? label.slice(state.poolId.length + 1) : label

const facts = computed(() => (state.dataRows ?? []).filter(r => !r.wide))
const wides = computed(() => (state.dataRows ?? []).filter(r => r.wide))

addEventListener("keydown", e => {
  if (e.key === "Escape" && state.open) {
    // resuming now would relock mid-press and the browser would treat the
    // same Esc as the exit gesture, ending the walk: relock on release
    container.close()
    addEventListener("keyup", () => walk.resume(), { once: true })
  }
})

const inner = (K, slot) => [K.ox + (slot % K.cols) * 18 + 1, K.oy + (slot / K.cols | 0) * 18 + 1]

// two stacked canvases: the gui texture + title draw immediately when the
// modal opens, items render on the overlay as they finish, so a re-roll
// never flashes the background away
// container section height: tiled guis are header + n slot rows, the rest
// use their fixed crop
const bodyH = K => K.tile ? 17 + K.rows * 18 : K.cropH

let bgSeq = 0
async function drawBg() {
  const c = bgEl.value, K = state.gui
  if (!c || !K) return
  const seq = ++bgSeq
  c.width = 176 * S
  c.height = (bodyH(K) + 7) * S
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
  if (K.tile) {
    ctx.drawImage(img, 0, 0, 176, 17, 0, 0, 176 * S, 17 * S)
    for (let r = 0; r < K.rows; r++) ctx.drawImage(img, 0, 17, 176, 18, 0, (17 + r * 18) * S, 176 * S, 18 * S)
  } else {
    ctx.drawImage(img, 0, 0, 176, K.cropH, 0, 0, 176 * S, K.cropH * S)
  }
  ctx.drawImage(img, 0, K.texH - 7, 176, 7, 0, bodyH(K) * S, 176 * S, 7 * S)
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
  c.height = (bodyH(K) + 7) * S
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
    const t = String(st.count)
    const [ix, iy] = inner(K, st.slot)
    const tx = (ix + 17) * S - measure(font, t) * S, ty = (iy + 9) * S
    drawText(ctx, font, t, tx + S, ty + S, { scale: S, color: "#3f3f3f" })
    drawText(ctx, font, t, tx, ty, { scale: S, color: "#ffffff" })
  }
}

watch(() => [state.open, state.gui, state.guiTitle], () => {
  if (state.open) nextTick(drawBg)
})
watch(() => [state.open, state.stacks, state.gui], () => {
  if (state.open) nextTick(drawItems)
})
</script>

<template>
  <div v-if="state.open" class="ct-backdrop" @pointerdown.self="close">
    <div class="ct-panel">
      <header>
        <div class="titles">
          <h3>{{ state.blockName }}</h3>
          <span class="tid">{{ state.tableId }}</span>
        </div>
        <button class="icon" title="Close" @click="close">
          <span class="material-symbols-outlined">close</span>
        </button>
      </header>
      <div v-if="state.error" class="err">{{ state.error }}</div>
      <template v-else>
        <nav class="tabs" v-if="TABS.length">
          <button v-for="t in TABS" :key="t.id" :class="{ active: state.tab === t.id }"
            @click="container.setTab(t.id)">{{ t.label }}</button>
        </nav>
        <div class="body" :class="{ compact: state.dataRows }">

          <div v-if="state.dataRows" class="pane data">
            <p v-if="state.blurb" class="blurb">{{ state.blurb }}</p>
            <div class="facts" v-if="facts.length">
              <div v-for="r in facts" :key="r.label" class="fact">
                <div class="fl">{{ r.label }}</div>
                <div class="fv" :class="{ mono: r.mono }">{{ r.value }}</div>
              </div>
            </div>
            <div v-for="r in wides" :key="r.label" class="wide-card">
              <div class="fl">{{ r.label }}</div>
              <pre>{{ r.value }}</pre>
            </div>
            <div v-if="state.poolId" class="pool-card">
              <div class="ph">
                <span class="fl phl">
                  <button v-if="state.poolStack.length" class="pback" title="Back to previous pool" @click="container.poolBack()">
                    <span class="material-symbols-outlined">arrow_back</span>
                  </button>
                  {{ state.poolStack.length ? "Fallback pool" : "Template pool" }}
                </span>
                <span class="pid">{{ state.poolId }}</span>
              </div>
              <div v-for="(p, i) in state.poolEntries ?? []" :key="i" class="pe"
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

          <div v-show="state.tab === 'loot' && !state.dataRows" class="pane loot">
            <div class="gui">
              <canvas ref="bgEl"></canvas>
              <canvas ref="itemsEl" class="items"></canvas>
            </div>
            <div v-if="state.note" class="note-line">{{ state.note }}</div>
          </div>

          <div v-if="state.tab === 'list'" class="pane">
            <div v-if="!listStacks.length" class="empty">Empty.</div>
            <div v-for="(s, i) in listStacks" :key="i" class="item-row">
              <ItemIcon :id="s.id" :components="s.components" :size="32" />
              <span class="nm" :title="stackName(s)">{{ stackName(s) }}</span>
              <span class="cntv big">×{{ s.count }}</span>
            </div>
          </div>

          <div v-if="state.tab === 'odds'" class="pane">
            <div v-if="state.oddsBusy" class="empty">Measuring drop rates over 10,000 opens…</div>
            <div v-else-if="state.odds && !state.odds.length" class="empty">This table never drops anything.</div>
            <template v-else-if="state.odds">
              <div class="cols"><span class="nm">Item · most common first</span><span class="chance-h">Chance</span><span class="cnt-h">Amount</span></div>
              <div v-for="o in state.odds" :key="o.id + JSON.stringify(o.components ?? null)" class="item-row">
                <ItemIcon :id="o.id" :components="o.components" :size="32" />
                <span class="nm" :title="stackName(o)">{{ stackName(o) }}</span>
                <span class="meter"><i :style="{ width: Math.max(o.chance * 100, 1.5) + '%' }"></i></span>
                <span class="pctv">{{ fmtPct(o.chance) }}</span>
                <span class="cntv">{{ fmtCount(o) }}</span>
              </div>
            </template>
          </div>

          <div v-if="state.tab === 'rules'" class="pane rules">
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
        <div class="actions" v-if="state.table && (state.tab === 'loot' || state.tab === 'list')">
          <button :disabled="rendering" @click="container.reroll()">
            <span class="material-symbols-outlined">shuffle</span>
            Re-roll
          </button>
          <span class="roll-stats" v-if="state.rolls > 1">
            {{ state.rolls }} opens · {{ state.pileTotal }} item{{ state.pileTotal === 1 ? "" : "s" }}
          </span>
          <span v-else></span>
          <div class="right">
            <button :disabled="rendering" @click="container.addRoll()">
              <span class="material-symbols-outlined">casino</span>
              Add Roll
            </button>
            <button :disabled="rendering" title="Add 100 rolls" @click="container.addRoll(100)">
              +100
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ct-backdrop {
  position: fixed;
  inset: 0;
  background: #00000080;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.ct-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 584px;
  max-width: calc(100vw - 32px);
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.titles h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.tid {
  font-size: 12px;
  color: var(--text-dim);
  font-family: ui-monospace, monospace;
}

button.icon {
  display: flex;
  align-items: center;
  padding: 4px;
}

.tabs {
  display: flex;
  gap: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px;
}

.tabs button {
  flex: 1;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 5px 0;
  color: var(--text-dim);
  font-size: 13px;
}

.tabs button:hover:not(.active) {
  background: #ffffff0a;
  color: var(--text);
}

.tabs button.active {
  background: var(--panel-2);
  border-color: var(--border);
  color: var(--text);
}

.body {
  overflow: auto;
  min-height: 280px;
}

.body.compact { min-height: 0; }

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

.fact {
  background: #ffffff05;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
}

.fact .fv {
  margin-top: 3px;
  overflow-wrap: anywhere;
}

.fact .fv.mono, .mono-nm {
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
}

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
  align-items: baseline;
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
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 10px;
}

.pool-card .pe:nth-child(even) { background: #ffffff05; }
.pool-card .pe.clickable { cursor: pointer; }
.pool-card .pe.clickable:hover { background: #ffffff0d; }
.pool-card .pe.clickable:hover .nm { color: var(--accent); }
.pool-card .pe .nm { flex: 1; }

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

.gui {
  position: relative;
  width: fit-content;
  margin: 0 auto;
}

.gui canvas { display: block; }

.gui .items {
  position: absolute;
  inset: 0;
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

/* shared item rows (odds + simulate) */
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

.item-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 6px;
  border-radius: 6px;
}

.item-row:nth-child(even) { background: #ffffff06; }
.item-row:hover { background: #ffffff0d; }

.nm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

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

/* rules */
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
</style>
