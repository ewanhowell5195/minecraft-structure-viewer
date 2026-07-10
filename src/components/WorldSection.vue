<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { useWorld } from "../composables/useWorld.js"
import { useLock } from "../composables/useLock.js"

const world = useWorld()
const { state } = world
const { locked } = useLock()
const collapsed = ref(false)
const mapEl = ref(null)
const hoverTxt = ref("")

// vertical cutoff slider bounds (the modern world height range)
const Y_LO = -64, Y_HI = 320
const fillStyle = computed(() => ({
  left: ((state.yMin - Y_LO) / (Y_HI - Y_LO) * 100) + "%",
  width: ((state.yMax - state.yMin) / (Y_HI - Y_LO) * 100) + "%"
}))

// fixed-size viewport over chunk space: worlds can span thousands of chunks,
// so the map pans (right-drag) and zooms (wheel) instead of growing
const VIEW = 272
let view = null // px per chunk + the chunk coord at the top-left corner
let bounds = null
let boundsFor = null

function computeBounds() {
  const chunks = world.getChunks()
  if (boundsFor === chunks) return
  boundsFor = chunks
  if (!chunks.length) {
    bounds = null
    view = null
    return
  }
  let minCx = Infinity, maxCx = -Infinity, minCz = Infinity, maxCz = -Infinity
  const present = new Set()
  for (const c of chunks) {
    minCx = Math.min(minCx, c.cx); maxCx = Math.max(maxCx, c.cx)
    minCz = Math.min(minCz, c.cz); maxCz = Math.max(maxCz, c.cz)
    present.add(c.cx + "," + c.cz)
  }
  bounds = { minCx, maxCx, minCz, maxCz, present }
  fitView()
}

function fitView() {
  const w = bounds.maxCx - bounds.minCx + 1, h = bounds.maxCz - bounds.minCz + 1
  const px = Math.min(14, Math.max(0.02, Math.min(VIEW / w, VIEW / h)))
  view = {
    px,
    cx0: bounds.minCx + w / 2 - VIEW / px / 2,
    cz0: bounds.minCz + h / 2 - VIEW / px / 2
  }
}

function draw() {
  const canvas = mapEl.value
  if (!canvas || !state.active) return
  computeBounds()
  canvas.width = canvas.height = VIEW
  const ctx = canvas.getContext("2d")
  ctx.clearRect(0, 0, VIEW, VIEW)
  if (!view) return
  const { px, cx0, cz0 } = view
  const cell = Math.max(1, px - (px >= 3 ? 1 : 0))
  for (const c of world.getChunks()) {
    const x = (c.cx - cx0) * px, y = (c.cz - cz0) * px
    if (x + px < 0 || y + px < 0 || x > VIEW || y > VIEW) continue
    ctx.fillStyle = world.isSelected(c.cx + "," + c.cz) ? "#4c8dff" : "#3a3a42"
    ctx.fillRect(x, y, cell, cell)
  }
  if (marquee) {
    // holding any selected chunks makes the box a remove (red)
    const on = !world.rectHasSelected(marquee.aCx, marquee.aCz, marquee.bCx, marquee.bCz)
    const x = (Math.min(marquee.aCx, marquee.bCx) - cx0) * px
    const y = (Math.min(marquee.aCz, marquee.bCz) - cz0) * px
    const w = (Math.abs(marquee.bCx - marquee.aCx) + 1) * px
    const h = (Math.abs(marquee.bCz - marquee.aCz) + 1) * px
    ctx.fillStyle = on ? "#4c8dff2e" : "#e06a6a2e"
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = on ? "#4c8dff" : "#e06a6a"
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  }
}

watch(() => [state.rev, state.active, collapsed.value], () => nextTick(draw))
onMounted(() => nextTick(draw))

function canvasPos(e) {
  const r = mapEl.value.getBoundingClientRect()
  return [(e.clientX - r.left) * (VIEW / r.width), (e.clientY - r.top) * (VIEW / r.height)]
}

function chunkCoords(e) {
  const [mx, my] = canvasPos(e)
  return [Math.floor(view.cx0 + mx / view.px), Math.floor(view.cz0 + my / view.px)]
}

function chunkAt(e) {
  if (!view || !bounds) return null
  const [cx, cz] = chunkCoords(e)
  const key = cx + "," + cz
  return bounds.present.has(key) ? key : null
}

// left drags a box selection, right/middle pans, wheel zooms at the cursor
let marquee = null, panning = null
function onDown(e) {
  if (e.button === 0) {
    if (!view || !bounds) return
    const [cx, cz] = chunkCoords(e)
    marquee = { aCx: cx, aCz: cz, bCx: cx, bCz: cz }
    draw()
  } else {
    panning = { x: e.clientX, y: e.clientY, cx0: view.cx0, cz0: view.cz0 }
  }
  mapEl.value.setPointerCapture(e.pointerId)
}
function onMove(e) {
  const k = chunkAt(e)
  hoverTxt.value = k ? `chunk ${k.replace(",", ", ")}` : ""
  if (panning) {
    const r = mapEl.value.getBoundingClientRect()
    const s = VIEW / r.width / view.px
    view.cx0 = panning.cx0 - (e.clientX - panning.x) * s
    view.cz0 = panning.cz0 - (e.clientY - panning.y) * s
    draw()
    return
  }
  if (!marquee) return
  const [cx, cz] = chunkCoords(e)
  if (cx !== marquee.bCx || cz !== marquee.bCz) {
    marquee.bCx = cx
    marquee.bCz = cz
    draw()
  }
}
function onUp() {
  if (marquee) {
    world.selectRect(marquee.aCx, marquee.aCz, marquee.bCx, marquee.bCz)
    marquee = null
  }
  panning = null
}
function onWheel(e) {
  if (!view) return
  e.preventDefault()
  const [mx, my] = canvasPos(e)
  const cx = view.cx0 + mx / view.px, cz = view.cz0 + my / view.px
  view.px = Math.min(14, Math.max(0.02, view.px * (e.deltaY < 0 ? 1.3 : 1 / 1.3)))
  view.cx0 = cx - mx / view.px
  view.cz0 = cz - my / view.px
  draw()
}
function onDblClick() {
  if (!bounds) return
  fitView()
  draw()
}
</script>

<template>
  <section v-if="state.active" :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      World
      <span class="count">{{ state.chunkCount }} chunks</span>
      <button class="icon" title="Close world" @click.stop="world.closeWorld()">
        <span class="material-symbols-outlined">close</span>
      </button>
    </h2>
    <div class="wname" :title="state.name">{{ state.name }}</div>
    <div v-if="state.error" class="err">{{ state.error }}</div>
    <template v-if="state.chunkCount">
      <canvas ref="mapEl" class="map" @pointerdown="onDown" @pointermove="onMove"
        @pointerup="onUp" @pointercancel="onUp" @pointerleave="hoverTxt = ''"
        @wheel="onWheel" @dblclick="onDblClick" @contextmenu.prevent></canvas>
      <div class="hint">{{ hoverTxt || "Drag a box to select · wheel zooms · right-drag pans" }}</div>
      <div class="yrange">
        <span class="ylabel">Y {{ state.yMin }} – {{ state.yMax }}</span>
        <div class="dual">
          <div class="track"></div>
          <div class="fill" :style="fillStyle"></div>
          <input type="range" :min="Y_LO" :max="Y_HI" :value="state.yMin"
            @input="world.setYRange(Math.min($event.target.valueAsNumber, state.yMax), state.yMax)">
          <input type="range" :min="Y_LO" :max="Y_HI" :value="state.yMax"
            @input="world.setYRange(state.yMin, Math.max($event.target.valueAsNumber, state.yMin))">
        </div>
        <button class="reset" title="Reset to Y 60–100" :disabled="state.yMin === 60 && state.yMax === 100"
          @click="world.setYRange(60, 100)">
          <span class="material-symbols-outlined">restart_alt</span>
        </button>
      </div>
      <div class="row">
        <button class="primary" :disabled="locked || state.busy || !state.selCount" @click="world.loadSelected()">
          Load {{ state.selCount || "" }} chunk{{ state.selCount === 1 ? "" : "s" }}
        </button>
        <button :disabled="!state.selCount" @click="world.clearSelection()">Clear</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
h2 .count {
  margin-left: auto;
  font-weight: 400;
  letter-spacing: normal;
  text-transform: none;
}

h2 .icon {
  padding: 0;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  background: none;
  border: none;
  color: var(--text-dim);
}

h2 .icon:hover {
  background: #ffffff14;
  color: var(--text);
}

h2 .icon .material-symbols-outlined { font-size: 15px; }

.wname {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.map {
  width: 100%;
  aspect-ratio: 1;
  image-rendering: pixelated;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: crosshair;
  touch-action: none;
}

.hint {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.err {
  font-size: 12px;
  color: var(--red);
}

.row {
  display: flex;
  gap: 6px;
}

.row .primary { flex: 1; }

.yrange {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ylabel {
  flex: none;
  min-width: 9ch;
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.dual {
  position: relative;
  flex: 1;
  height: 18px;
}

.dual .track, .dual .fill {
  position: absolute;
  top: 50%;
  height: 3px;
  transform: translateY(-50%);
  border-radius: 2px;
  pointer-events: none;
}

.dual .track {
  left: 0;
  right: 0;
  background: var(--border);
}

.dual .fill { background: var(--accent); }

.dual input {
  position: absolute;
  inset: 0;
  width: 100%;
  margin: 0;
  background: none;
  border: none;
  padding: 0;
  pointer-events: none;
  -webkit-appearance: none;
  appearance: none;
}

.dual input::-webkit-slider-thumb {
  pointer-events: auto;
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
  border: none;
  cursor: ew-resize;
}

.dual input::-moz-range-thumb {
  pointer-events: auto;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
  border: none;
  cursor: ew-resize;
}

.dual input::-webkit-slider-runnable-track { background: transparent; }
.dual input::-moz-range-track { background: transparent; }

.yrange .reset {
  flex: none;
  padding: 2px;
}

.yrange .reset:disabled {
  opacity: 0.35;
  cursor: default;
}

.yrange .reset .material-symbols-outlined { font-size: 16px; }
</style>
