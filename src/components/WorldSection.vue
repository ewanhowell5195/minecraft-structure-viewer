<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { useWorld } from "../composables/useWorld.js"
import { useLock } from "../composables/useLock.js"
import { createGridRenderer, GRID } from "../world.js"

const world = useWorld()
const { state } = world
const { locked } = useLock()
const collapsed = ref(false)
const mapEl = ref(null)
const hoverTxt = ref("")

// the modern world height range
const Y_LO = -64, Y_HI = 320
const fillStyle = computed(() => ({
  left: ((state.yMin - Y_LO) / (Y_HI - Y_LO) * 100) + "%",
  width: ((state.yMax - state.yMin) / (Y_HI - Y_LO) * 100) + "%"
}))

const CHUNKS = [64, 48, 32, 24, 16, 12, 8]
const ZI_BASE = 4
let W = 287
const pxFor = zi => Math.max(3, Math.round(W / CHUNKS[zi]))
let view = null
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
  const px = pxFor(ZI_BASE)
  view = {
    zi: ZI_BASE,
    px,
    cx0: bounds.minCx + w / 2 - W / px / 2,
    cz0: bounds.minCz + h / 2 - W / px / 2
  }
}

let R = null, win = null, dataRev = -1

function draw() {
  const canvas = mapEl.value
  if (!canvas || !state.active) return
  computeBounds()
  if (!view) return
  if (!R || R.canvas !== canvas) {
    R = createGridRenderer(canvas)
    R.resize(W)
    win = null
  }
  const dev = Math.max(1, Math.round((canvas.getBoundingClientRect().width - 2) * (window.devicePixelRatio || 1)))
  if (dev !== W) {
    W = dev
    R.resize(W)
  }
  view.px = pxFor(view.zi)
  const { px, cx0, cz0 } = view
  const span = W / px
  const wSpan = GRID / 8
  const covered = win &&
    cx0 >= win.w0x && cz0 >= win.w0z && cx0 + span <= win.w0x + wSpan && cz0 + span <= win.w0z + wSpan
  if (!covered || dataRev !== state.rev) {
    win = {
      w0x: Math.floor(cx0 + span / 2 - wSpan / 2),
      w0z: Math.floor(cz0 + span / 2 - wSpan / 2)
    }
    world.fillGridWindow(R.data, win.w0x, win.w0z, GRID)
    R.upload()
    dataRev = state.rev
  }
  const cellW = px - (px >= 7 ? 1 : 0)
  const level = Math.min(8, Math.max(1, Math.pow(2, Math.floor(Math.log2(cellW)) - 1)))
  const marqueeOn = marquee ? !world.rectHasSelected(marquee.aCx, marquee.aCz, marquee.bCx, marquee.bCz) : false
  R.draw({ ...win, cx0: Math.round(cx0 * px) / px, cz0: Math.round(cz0 * px) / px, px, cellW, level, marquee, marqueeOn })
  world.setScanFocus(Math.floor(cx0), Math.floor(cz0), Math.ceil(cx0 + span), Math.ceil(cz0 + span))
}

watch(() => [state.rev, state.active, collapsed.value], () => nextTick(draw))
onMounted(() => nextTick(draw))
const ro = new ResizeObserver(() => draw())
watch(mapEl, (el, old) => { if (old) ro.unobserve(old); if (el) ro.observe(el) })

function canvasPos(e) {
  const r = mapEl.value.getBoundingClientRect()
  return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (W / r.height)]
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
    const s = W / r.width / view.px
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
  view.zi = Math.min(CHUNKS.length - 1, Math.max(0, view.zi + (e.deltaY < 0 ? 1 : -1)))
  view.px = pxFor(view.zi)
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
      <div class="checks">
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
