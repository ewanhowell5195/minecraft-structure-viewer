<script setup>
import { computed, nextTick, ref, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "../composables/usePacks.js"
import { useContainer } from "../composables/useContainer.js"
import { useWalk } from "../composables/useWalk.js"
import { getFont, measure, drawText } from "../mcfont.js"
import { describeTable } from "../loot.js"

const packs = usePacks()
const container = useContainer()
const state = container.state
const walk = useWalk()
const bgEl = ref(null)
const itemsEl = ref(null)
const rendering = ref(false)
const S = 3

const rules = computed(() => state.table ? describeTable(state.table) : [])

function close() {
  container.close()
  walk.resume() // no-op unless a walk session is waiting behind the modal
}

addEventListener("keydown", e => {
  if (e.key === "Escape" && state.open) close()
})

const inner = (K, slot) => [K.ox + (slot % K.cols) * 18 + 1, K.oy + (slot / K.cols | 0) * 18 + 1]

// two stacked canvases: the gui texture + title draw immediately when the
// modal opens, items render on the overlay as they finish, so a re-roll
// never flashes the background away
let bgSeq = 0
async function drawBg() {
  const c = bgEl.value, K = state.kind
  if (!c || !K) return
  const seq = ++bgSeq
  c.width = 176 * S
  c.height = (K.cropH + 7) * S
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
  ctx.drawImage(img, 0, 0, 176, K.cropH, 0, 0, 176 * S, K.cropH * S)
  ctx.drawImage(img, 0, K.texH - 7, 176, 7, 0, K.cropH * S, 176 * S, 7 * S)
  drawText(ctx, font, state.blockName, 8 * S, 6 * S, { scale: S, color: "#404040" })
}

let itemSeq = 0
async function drawItems() {
  const c = itemsEl.value, K = state.kind
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
  c.height = (K.cropH + 7) * S
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

watch(() => [state.open, state.kind, state.blockName], () => {
  if (state.open) nextTick(drawBg)
})
watch(() => [state.open, state.stacks], () => {
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
        <div class="gui">
          <canvas ref="bgEl"></canvas>
          <canvas ref="itemsEl" class="items"></canvas>
        </div>
        <div class="actions">
          <button :disabled="rendering" @click="container.reroll()">
            <span class="material-symbols-outlined">shuffle</span>
            Re-roll
          </button>
        </div>
        <div class="rules">
          <div v-for="(pool, pi) in rules" :key="pi" class="pool">
            <div class="pool-head">
              Pool {{ pi + 1 }} · {{ pool.rolls }} roll{{ pool.rolls === "1" ? "" : "s" }}<template v-if="pool.bonus"> (+{{ pool.bonus }} bonus)</template><template v-if="pool.chance"> · {{ pool.chance }}</template>
            </div>
            <div v-for="(en, ei) in pool.entries" :key="ei" class="entry">
              <span class="pct">{{ en.pct }}%</span>
              <span class="nm">{{ en.name }}<span v-if="en.note" class="note"> · {{ en.note }}</span></span>
              <span class="cnt">{{ en.count ? "×" + en.count : "" }}</span>
            </div>
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
  border-radius: 8px;
  padding: 14px;
  max-height: 88vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 380px;
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
  display: flex;
  justify-content: center;
}

.actions button {
  display: flex;
  align-items: center;
  gap: 6px;
}

.actions .material-symbols-outlined { font-size: 18px; }

.err { color: var(--red); font-size: 13px; }

.rules {
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pool-head {
  color: var(--text);
  font-weight: 600;
  margin-bottom: 4px;
}

.entry {
  display: flex;
  gap: 8px;
  padding: 1px 0;
  color: var(--text-dim);
  font-family: ui-monospace, monospace;
}

.pct {
  width: 48px;
  text-align: right;
  flex-shrink: 0;
}

.nm { flex: 1; }
.note { opacity: 0.7; }
.cnt { flex-shrink: 0; }
</style>
