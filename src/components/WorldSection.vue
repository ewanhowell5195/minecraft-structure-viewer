<script setup>
import { computed, nextTick, onMounted, provide, ref, watch } from "vue"
import { useWorld } from "../composables/useWorld.js"
import { useStructures } from "../composables/useStructures.js"
import { useStructure } from "../composables/useStructure.js"
import { useContextMenu } from "../composables/useContextMenu.js"
import { useLock } from "../composables/useLock.js"
import { createGridRenderer, GRID } from "../world.js"
import { numeric } from "../transforms.js"
import Modal from "./Modal.vue"
import TreeFolder from "./TreeFolder.vue"
import { useStream } from "../composables/useStream.js"
import { useWalk } from "../composables/useWalk.js"

const world = useWorld()
const { state } = world
const structures = useStructures()
const { loadVanilla, loadMany } = useStructure()
const ctx = useContextMenu()
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

const willTruncate = computed(() => {
  void state.selCount; void state.yMin; void state.yMax
  return world.loadForecast()
})

const fakePct = ref(0)
let fakeTimer = null
watch(() => !!(state.loading && !state.loading.total), active => {
  clearInterval(fakeTimer)
  if (active) {
    fakePct.value = 0
    fakeTimer = setInterval(() => { fakePct.value += (10 - fakePct.value) * 0.08 }, 100)
  }
}, { immediate: true })

const loadPct = computed(() => {
  const l = state.loading
  if (!l) return 0
  return l.total ? 10 + l.done / l.total * 90 : fakePct.value
})

provide("treeApi", {
  selected: () => structures.state.selected,
  open: (rel, ev) => loadVanilla(rel, ev),
  loadAll: rels => loadMany(rels),
  fileMenu: null
})

// the save's generated structures; namespaces only show when there are several
const structTree = computed(() => {
  const multiNs = new Set(state.structs.map(s => s.ns)).size > 1
  const entries = state.structs
    .map(s => ({ rel: s.rel, path: multiNs ? s.ns + "/" + s.path : s.path }))
    .sort((a, b) => numeric(a.path, b.path))
  const root = { dirs: new Map(), files: [] }
  for (const { rel, path } of entries) {
    const parts = path.split("/")
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] })
      node = node.dirs.get(parts[i])
    }
    node.files.push(rel)
  }
  return root
})

const rootExpand = ref(0), rootCollapse = ref(0)
function onStructRootMenu(e) {
  const rels = state.structs.map(s => s.rel)
  ctx.open(e, [
    { label: `Load all (${rels.length})`, icon: "stacks", disabled: locked.value || !rels.length, action: () => loadMany(rels) },
    { label: "Expand all", icon: "unfold_more", action: () => rootExpand.value++ },
    { label: "Collapse all", icon: "unfold_less", action: () => rootCollapse.value++ }
  ])
}

const DIM_LABELS = { overworld: "Overworld", the_nether: "The Nether", the_end: "The End" }
const dimLabel = d => DIM_LABELS[d] ?? d

const ZI_BASE = 7
let W = 287
const pxFor = zi => [1, 2, 3,
  Math.round(W / 64), Math.round(W / 48), Math.round(W / 32), Math.round(W / 24),
  Math.round(W / 16), Math.round(W / 12), Math.round(W / 8)][zi]
const ZI_MAX = 9
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
  const buckets = new Map()
  let bestBucket = null, bestCount = 0
  for (const c of chunks) {
    minCx = Math.min(minCx, c.cx); maxCx = Math.max(maxCx, c.cx)
    minCz = Math.min(minCz, c.cz); maxCz = Math.max(maxCz, c.cz)
    present.add(c.cx + "," + c.cz)
    const k = (c.cx >> 5) + "," + (c.cz >> 5)
    const n = (buckets.get(k) ?? 0) + 1
    buckets.set(k, n)
    if (n > bestCount) { bestCount = n; bestBucket = k }
  }
  const [hx, hz] = bestBucket.split(",").map(Number)
  let homeCx = hx * 32 + 16, homeCz = hz * 32 + 16
  // the origin bias targets world spawns; a lone region file centers on itself
  if (state.regionFile) {
    homeCx = (minCx + maxCx + 1) / 2
    homeCz = (minCz + maxCz + 1) / 2
  } else {
    origin: for (let z = -8; z < 8; z++) for (let x = -8; x < 8; x++) {
      if (present.has(x + "," + z)) { homeCx = 0; homeCz = 0; break origin }
    }
  }
  bounds = { minCx, maxCx, minCz, maxCz, present, homeCx, homeCz }
  fitView()
}

function fitView() {
  const sel = world.selectionBounds()
  let zi = ZI_BASE
  let cx, cz
  if (sel) {
    const need = Math.max(sel.maxCx - sel.minCx, sel.maxCz - sel.minCz) + 3
    while (zi > 0 && W / pxFor(zi) < need) zi--
    cx = (sel.minCx + sel.maxCx + 1) / 2
    cz = (sel.minCz + sel.maxCz + 1) / 2
  } else {
    cx = bounds.homeCx
    cz = bounds.homeCz
  }
  const px = pxFor(zi)
  view = {
    zi,
    px,
    cx0: cx - W / px / 2,
    cz0: cz - W / px / 2
  }
}

let R = null, win = null, dataRev = -1

// the nearest chunk to the map centre that exists in the world, searched over
// the visible window only; spirals outward and exits on the first hit, so it
// only pays a full sweep when nothing in view is valid
function nearestValidChunk() {
  if (!view || !bounds) return null
  const span = W / view.px
  const x0 = Math.max(Math.floor(view.cx0), bounds.minCx)
  const z0 = Math.max(Math.floor(view.cz0), bounds.minCz)
  const x1 = Math.min(Math.ceil(view.cx0 + span) - 1, bounds.maxCx)
  const z1 = Math.min(Math.ceil(view.cz0 + span) - 1, bounds.maxCz)
  if (x0 > x1 || z0 > z1) return null
  const mx = view.cx0 + span / 2, mz = view.cz0 + span / 2
  const cx = Math.floor(mx), cz = Math.floor(mz)
  const d2 = (x, z) => (x + 0.5 - mx) ** 2 + (z + 0.5 - mz) ** 2
  const maxR = Math.max(Math.abs(x0 - cx), Math.abs(x1 - cx), Math.abs(z0 - cz), Math.abs(z1 - cz))
  let best = null, bestD = Infinity
  const tryCell = (x, z) => {
    if (x < x0 || x > x1 || z < z0 || z > z1) return
    if (!bounds.present.has(x + "," + z)) return
    const d = d2(x, z)
    if (d < bestD) { bestD = d; best = { cx: x, cz: z } }
  }
  for (let r = 0; r <= maxR; r++) {
    // chebyshev rings don't order by distance exactly: once something is
    // found, rings beyond its euclidean distance can't beat it
    if (best && (r - 1) ** 2 > bestD) break
    if (r === 0) tryCell(cx, cz)
    else {
      for (let x = cx - r; x <= cx + r; x++) { tryCell(x, cz - r); tryCell(x, cz + r) }
      for (let z = cz - r + 1; z <= cz + r - 1; z++) { tryCell(cx - r, z); tryCell(cx + r, z) }
    }
  }
  return best
}

const explorable = ref(false)

// enter streaming at the nearest valid chunk to the map's centre
async function exploreWorld() {
  const spawn = nearestValidChunk()
  if (!spawn) return
  const u = new URL(location)
  u.searchParams.set("wy", state.yMin + "," + state.yMax)
  history.replaceState(null, "", u)
  const stream = useStream()
  if (stream.state.session) stream.shutdown()
  if (await stream.enter(spawn)) useWalk().enter()
}

function draw() {
  const canvas = mapEl.value
  if (!canvas || !state.active) return
  computeBounds()
  if (!view) { explorable.value = false; return }
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
  const tpc = span > GRID / 8 - 8 ? 1 : 8
  const wSpan = GRID / tpc
  const covered = win && win.tpc === tpc &&
    cx0 >= win.w0x && cz0 >= win.w0z && cx0 + span <= win.w0x + wSpan && cz0 + span <= win.w0z + wSpan
  if (!covered || dataRev !== state.rev) {
    win = {
      tpc,
      w0x: Math.floor(cx0 + span / 2 - wSpan / 2),
      w0z: Math.floor(cz0 + span / 2 - wSpan / 2)
    }
    world.fillGridWindow(R.data, win.w0x, win.w0z, GRID, tpc)
    R.upload()
    dataRev = state.rev
  }
  const cellW = px - (view.zi >= 7 ? 1 : 0)
  const level = Math.min(8, Math.max(1, Math.pow(2, Math.floor(Math.log2(cellW)) - 1)))
  const marqueeOn = marquee ? !world.rectHasSelected(marquee.aCx, marquee.aCz, marquee.bCx, marquee.bCz) : false
  R.draw({ ...win, cx0: Math.round(cx0 * px) / px, cz0: Math.round(cz0 * px) / px, px, cellW, level, marquee, marqueeOn })
  world.setScanFocus(Math.floor(cx0), Math.floor(cz0), Math.ceil(cx0 + span), Math.ceil(cz0 + span))
  explorable.value = !!nearestValidChunk()
}

watch(() => [state.rev, state.active, collapsed.value], () => nextTick(draw))
watch(() => state.focusRev, () => nextTick(() => { if (bounds) { fitView(); draw() } }))
onMounted(() => nextTick(draw))
const ro = new ResizeObserver(() => draw())
watch(mapEl, (el, old) => {
  if (old) ro.unobserve(old)
  if (el) {
    ro.observe(el)
    el.addEventListener("webglcontextlost", e => e.preventDefault())
    el.addEventListener("webglcontextrestored", () => { R = null; nextTick(draw) })
  }
})
document.addEventListener("visibilitychange", () => { if (!document.hidden) nextTick(draw) })

const hovering = ref(false)
window.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !hovering.value) return
  if (marquee) cancelMarquee()
  else world.clearSelection()
})

function canvasPos(e) {
  const r = mapEl.value.getBoundingClientRect()
  return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (W / r.height)]
}

function chunkCoords(e) {
  const [mx, my] = canvasPos(e)
  return [Math.floor(view.cx0 + mx / view.px), Math.floor(view.cz0 + my / view.px)]
}

let marquee = null, panning = null

function marqueeHint() {
  const on = !world.rectHasSelected(marquee.aCx, marquee.aCz, marquee.bCx, marquee.bCz)
  const x0 = Math.min(marquee.aCx, marquee.bCx), x1 = Math.max(marquee.aCx, marquee.bCx)
  const z0 = Math.min(marquee.aCz, marquee.bCz), z1 = Math.max(marquee.aCz, marquee.bCz)
  let n = 0
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const key = x + "," + z
    if (bounds.present.has(key) && world.isSelected(key) !== on) n++
  }
  hoverTxt.value = `${on ? "+" : "-"}${n} chunk${n === 1 ? "" : "s"}`
}

function onDown(e) {
  if (e.button === 0) {
    if (!view || !bounds) return
    const [cx, cz] = chunkCoords(e)
    marquee = { aCx: cx, aCz: cz, bCx: cx, bCz: cz }
    marqueeHint()
    draw()
  } else {
    panning = { x: e.clientX, y: e.clientY, cx0: view.cx0, cz0: view.cz0 }
  }
  mapEl.value.setPointerCapture(e.pointerId)
}
function cancelMarquee() {
  marquee = null
  hoverTxt.value = ""
  draw()
}

function onMove(e) {
  // pressing right mid-drag arrives as a chorded pointermove, not a pointerdown
  if (marquee && (e.buttons & 2)) return cancelMarquee()
  if (view && !marquee) {
    const [mx, my] = canvasPos(e)
    const cfx = view.cx0 + mx / view.px, cfz = view.cz0 + my / view.px
    const cx = Math.floor(cfx), cz = Math.floor(cfz)
    let t = `block ${Math.floor(cfx * 16)}, ${Math.floor(cfz * 16)} · chunk ${cx}, ${cz}`
    if (!state.regionFile) t += ` · region ${cx >> 5}, ${cz >> 5}`
    hoverTxt.value = t
  }
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
    marqueeHint()
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
  view.zi = Math.min(ZI_MAX, Math.max(0, view.zi + (e.deltaY < 0 ? 1 : -1)))
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
    <div class="wname-row">
      <div class="wname" :title="state.name">{{ state.name }}</div>
      <button v-if="state.chunkCount" class="icon" title="Reset view" @click="onDblClick">
        <span class="material-symbols-outlined">recenter</span>
      </button>
    </div>
    <select v-if="state.dimensions.length > 1" class="dimsel" :value="state.dimension" :disabled="state.busy"
      @change="world.setDimension($event.target.value)">
      <option v-for="d in state.dimensions" :key="d" :value="d">{{ dimLabel(d) }}</option>
    </select>
    <div v-if="state.error" class="err">{{ state.error }}</div>
    <div v-if="state.loading" class="loadbar">
      <div class="fill" :style="{ width: loadPct + '%' }"></div>
    </div>
    <template v-if="state.chunkCount">
      <button class="explore-btn" :disabled="locked || !explorable" @click="exploreWorld">
        <span class="material-symbols-outlined">public</span>
        {{ explorable ? "Explore World" : "No Valid Chunks" }}
      </button>
      <canvas ref="mapEl" class="map" @pointerdown="onDown" @pointermove="onMove"
        @pointerup="onUp" @pointercancel="onUp"
        @pointerenter="hovering = true" @pointerleave="hovering = false; hoverTxt = ''"
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
          <button v-if="state.rangeWarn" class="reset warn"
            title="Nothing is visible here in this Y range. Click to switch to a suggested range"
            @click="world.applySuggestedRange()">
            <span class="material-symbols-outlined">warning</span>
          </button>
        </div>
      </div>
      <div class="row">
        <button class="primary" :class="{ warnload: willTruncate }" :disabled="locked || state.busy || !state.selCount"
          :title="willTruncate ? 'this selection may exceed memory: loading may stop early and show a partial world' : ''"
          @click="world.loadSelected()">
          <span v-if="willTruncate" class="material-symbols-outlined">warning</span>
          Load {{ state.selCount || "" }} chunk{{ state.selCount === 1 ? "" : "s" }}
        </button>
        <button :disabled="!state.selCount" @click="world.clearSelection()">Clear</button>
      </div>
      <div v-if="state.structs.length" class="tree" :class="{ disabled: locked }">
        <div class="tree-root" title="Right-click for options" @contextmenu.prevent="onStructRootMenu($event)">World Structures</div>
        <div class="root-children">
          <TreeFolder :node="structTree" :expand-token="rootExpand" :collapse-token="rootCollapse" />
        </div>
      </div>
    </template>
    <Modal v-if="state.memWarn" :width="340" :z="250" :closable="false" :dismissable="false" style="--modal-gap: 0px" class="mw">
      <h3>Large selection</h3>
      <p>This selection may need more memory than the browser has. Loading may stop early and show a partial world.</p>
      <div class="mrow">
        <button class="primary" @click="world.answerMemWarn(true)">Load anyway</button>
        <button @click="world.answerMemWarn(false)">Cancel</button>
      </div>
    </Modal>
    <Modal v-if="state.stopped" :width="340" :z="250" :closable="false" :dismissable="false" style="--modal-gap: 0px" class="mw">
      <h3>Loading stopped early</h3>
      <p>The memory limit was reached: showing {{ state.stopped.loaded }} of {{ state.stopped.total }} chunks.</p>
      <div class="mrow">
        <button class="primary" @click="world.dismissStopped()">OK</button>
      </div>
    </Modal>
    <Modal v-if="state.oldWorld" :width="340" :z="250" :closable="false" :dismissable="false" style="--modal-gap: 0px" class="mw">
      <h3>World too old</h3>
      <p>This world has chunks in the pre-1.18 format, which can't be read. They'll be skipped when loading; open the world in Minecraft 1.18 or newer to upgrade them.</p>
      <div class="mrow">
        <button class="primary" @click="world.dismissOldWorld()">OK</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
h2 .count {
  margin-left: auto;
  font-weight: 400;
  letter-spacing: normal;
  text-transform: none;
}

h2 .icon,
.wname-row .icon {
  padding: 0;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  background: none;
  border: none;
  color: var(--text-dim);
}

h2 .icon:hover,
.wname-row .icon:hover {
  background: #ffffff14;
  color: var(--text);
}

h2 .icon .material-symbols-outlined,
.wname-row .icon .material-symbols-outlined { font-size: 15px; }

.dimsel {
  width: 100%;
}

.wname-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.wname {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.explore-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  background: var(--green);
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}

.explore-btn:hover:not(:disabled) { background: #4cb87a; }
.explore-btn:disabled { opacity: 0.5; cursor: default; }
.explore-btn .material-symbols-outlined { font-size: 18px; }

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

.loadbar {
  height: 6px;
  border-radius: 3px;
  background: #ffffff14;
  overflow: hidden;
}

.loadbar .fill {
  height: 100%;
  background: #4c8dff;
  transition: width 0.15s;
}

.tree {
  max-height: 220px;
  overflow: auto;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  user-select: none;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
}

.tree-root {
  color: var(--text);
  font-weight: 600;
  padding: 1px 0;
  cursor: context-menu;
  user-select: none;
}

.tree-root:hover { color: #fff; }

.root-children { margin-left: 14px; }

.tree.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.mw :deep(.modal-panel) {
  padding: 18px 20px;
  box-shadow: 0 10px 40px #00000080;
}

.mw h3 {
  margin: 0 0 8px;
  font-size: 15px;
}

.mw p {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--text-dim);
}

.mrow {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.warnload {
  background: #8a6d1f;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.warnload .material-symbols-outlined { font-size: 14px; }

.warnload:hover:not(:disabled) { background: #a3831f; }

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

.yrange .warn { color: #e0b34c; }
</style>
