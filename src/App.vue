<script setup>
import { computed, onMounted, ref, watch } from "vue"
import { loadLibrary } from "./lib.js"
import { usePacks } from "./composables/usePacks.js"
import { useStructures } from "./composables/useStructures.js"
import { useStructure, decodeStructureParam, parseSeedParam, beginInit, endInit } from "./composables/useStructure.js"
import { useBuild } from "./composables/useBuild.js"
import { useScene } from "./composables/useScene.js"
import { useLock } from "./composables/useLock.js"
import { useWalk } from "./composables/useWalk.js"
import { useStream } from "./composables/useStream.js"
import { useWorld } from "./composables/useWorld.js"
import { restoreFile } from "./userCache.js"
import { useContainer } from "./composables/useContainer.js"
import { useSlicers } from "./composables/useSlicers.js"
import { tab } from "./composables/useTab.js"
import { minimal } from "./minimal.js"
import { isRemote, prefetchRemote } from "./remote.js"
import PacksSection from "./components/PacksSection.vue"
import StructuresSection from "./components/StructuresSection.vue"
import FeaturesSection from "./components/FeaturesSection.vue"
import WorldSection from "./components/WorldSection.vue"
import ViewSection from "./components/ViewSection.vue"
import SlicersSection from "./components/SlicersSection.vue"
import SceneSection from "./components/SceneSection.vue"
import LevelMenu from "./components/LevelMenu.vue"
import WalkOverlay from "./components/WalkOverlay.vue"
import FpsCounter from "./components/FpsCounter.vue"
import ContainerModal from "./components/ContainerModal.vue"
import UsedBlocksModal from "./components/UsedBlocksModal.vue"
import ContextMenu from "./components/ContextMenu.vue"
import BuildProgress from "./components/BuildProgress.vue"
import BuildWarning from "./components/BuildWarning.vue"
import Modal from "./components/Modal.vue"

const libError = ref("")
const canvasEl = ref(null)
const usedModal = ref(null)
const { loadBase, restoreCachedPacks, addUrlPacks, state: packsState } = usePacks()
const structures = useStructures()
const { state: current, structure, loadVanilla, loadDefault, loadMany, loadFile, loadDebug, loadFeature, loadFeatures, loadFeatureField, cancelReading } = useStructure()
const { state: buildState, cancel: cancelBuild } = useBuild()
const sceneApi = useScene()
const walk = useWalk()
const stream = useStream()
const walkMenu = ref(false)
async function walkClick() {
  if (!worldState.active) return walk.enter()
  walkMenu.value = !walkMenu.value
}
async function walkStream() {
  walkMenu.value = false
  if (await stream.enter()) walk.enter()
}
const walkState = walk.state
const { locked } = useLock()
const { state: containerState } = useContainer()

const worldState = useWorld().state

const minimalReady = ref(!minimal)
const notFound = ref("")
// refreshed on pointerdown so the link always carries the current url state
const mainSiteUrl = ref("")
const homeUrl = location.origin + location.pathname
function refreshMainSiteUrl() {
  const u = new URL(location.href)
  u.searchParams.delete("minimal")
  mainSiteUrl.value = u.href
}
refreshMainSiteUrl()

const fullscreenSupported = document.fullscreenEnabled ?? false
const isFullscreen = ref(false)
document.addEventListener("fullscreenchange", () => isFullscreen.value = !!document.fullscreenElement)
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else document.documentElement.requestFullscreen()
}

watch(() => !!buildState.info || !!current.error, ready => {
  if (ready) minimalReady.value = true
})

// the cancel buttons only appear once a load has been running for a while
const cancelReady = ref(false)
let cancelTimer = null
watch(() => buildState.building || !!current.reading, active => {
  clearTimeout(cancelTimer)
  if (active) cancelTimer = setTimeout(() => cancelReady.value = true, 5000)
  else cancelReady.value = false
})

// a load that stops without producing a build (cancel button, large-build
// warning declined) drops the minimal splash back to the plain description
const splashCancelled = ref(false)
let sawLoad = false
watch(() => buildState.building || !!current.reading || !!buildState.status, active => {
  if (active) { sawLoad = true; splashCancelled.value = false; return }
  if (!minimal || minimalReady.value || !sawLoad) return
  setTimeout(() => {
    if (!minimalReady.value && !buildState.building && !current.reading && !buildState.status) splashCancelled.value = true
  }, 400)
})

function splashCancel() {
  if (current.reading) cancelReading()
  else cancelBuild()
  splashCancelled.value = true
}

// zero-width breaks so long structure paths wrap at their slashes
const splashName = computed(() => current.name.replace(/\//g, "/\u200B"))

const STAGE_LABELS = { light: "lighting", build: "building", optimise: "optimising", maps: "generating maps" }
const splashStatus = computed(() => {
  // pack and jar downloads run concurrently; show both, but "loading…" is
  // just the pre-download placeholder and never worth a second slot
  const dl = []
  if (packsState.remoteStatus) dl.push(packsState.remoteStatus)
  if (packsState.baseStatus && !(dl.length && packsState.baseStatus === "loading…")) dl.push(packsState.baseStatus)
  if (dl.length) return dl.join(" · ")
  const p = current.reading ? { ...current.reading, phase: "read" } : buildState.progress
  if (p?.total) {
    const stage = p.phase === "read" ? (p.label || "reading structures") : STAGE_LABELS[p.phase] ?? p.phase
    return `${stage}… ${Math.min(100, Math.round(p.done / p.total * 100))}%`
  }
  return buildState.status || "loading…"
})

const fmtK = n => n >= 1000 ? +(n / 1000).toFixed(1) + "K" : String(Math.round(n))

const info = computed(() => {
  const i = buildState.info
  if (!i) return ""
  const name = current.name ? `${current.name.replace(/\//g, "/\u200B")} · ` : ""
  const fmt = n => n.toLocaleString("en")
  const perf = minimal ? "" : ` · ${i.draws} draws · ${fmtK(i.tris)} tris`
  return `${name}${i.size} · ${fmt(i.blocks)} blocks, ${fmt(i.palette)} unique${perf}`
})

const usedLabel = computed(() => buildState.info?.blocks === 0 && structure.value?.entities?.length ? "Entities" : "Blocks")

// id + blockstates of the block under the pointer, under the info chip
const aim = computed(() => {
  const a = containerState.aim
  if (!a) return ""
  const props = a.props ? Object.entries(a.props).map(([k, v]) => `${k}=${v}`).join(" ") : ""
  return props ? `${a.name} · ${props}` : a.name
})

onMounted(async () => {
  try {
    await loadLibrary()
  } catch (err) {
    libError.value = String(err)
    return
  }
  sceneApi.init(canvasEl.value)
  useSlicers().init()
  useContainer().initPicking(canvasEl.value)
  // load the requested structure (?debug = the generated mesher test scene),
  // or a default so the page never starts empty
  const params = new URLSearchParams(location.search)
  const structureParam = params.get("structure")
  const debug = params.get("debug")
  const feature = params.get("feature")
  const requested = await decodeStructureParam(structureParam)
  prefetchRemote(requested.filter(isRemote))
  const stop = watch(() => structures.state.names.length, async n => {
    if (!n) return
    stop()
    beginInit()
    try {
      // the world restores first so its structures resolve for the param filter below
      // (minimal embeds ignore all cached user files and load fresh from the URL)
      const worldFile = minimal ? null : await restoreFile("world")
      if (worldFile) await useWorld().openWorld(worldFile, false)
      const wsel = params.get("wsel")
      if (worldFile && params.get("wloaded") === "1" && wsel) {
        await useWorld().restoreLoad(params.get("wy"), wsel, params.get("wdim"))
        return
      }
      const rels = requested.filter(r => isRemote(r) || structures.has(r))
      if (structureParam != null && !rels.length) {
        notFound.value = requested.length === 1
          ? `Structure not found: ${requested[0].replace(/\//g, "/\u200B")}`
          : "None of the linked structures were found"
      }
      const structureFile = minimal || rels.length || debug != null || feature != null ? null : await restoreFile("structure")
      if (debug != null) await loadDebug(debug)
      else if (feature != null && feature.includes(",")) await loadFeatures(feature.split(","))
      else if (feature != null && params.get("field") != null) await loadFeatureField(feature, parseSeedParam(params.get("fseed")))
      else if (feature != null) await loadFeature(feature, parseSeedParam(params.get("fseed")))
      else if (rels.length > 1 || rels.some(isRemote)) await loadMany(rels)
      else if (rels.length === 1) await loadVanilla(rels[0])
      else if (structureFile) await loadFile(structureFile, false)
      else if (!(minimal && notFound.value)) await loadDefault()
    } finally {
      endInit()
    }
    useSlicers().restoreUrlSlice()
  })
  const packUrls = (params.get("packs") ?? "").split(",").filter(Boolean)
  const urlPacks = packUrls.length ? addUrlPacks(packUrls) : undefined
  if (!minimal) await restoreCachedPacks()
  await loadBase(undefined, urlPacks)
})
</script>

<template>
  <div class="layout" :class="{ minimal }">
    <aside v-if="!minimal" class="sidebar">
      <header class="app-head">
        <span class="material-symbols-outlined">deployed_code</span>
        <h1>Structure Viewer</h1>
      </header>
      <div v-if="libError" class="lib-error">Renderer failed: {{ libError }}</div>
      <template v-else>
        <PacksSection />
        <StructuresSection v-show="tab === 'structures' && !worldState.active" />
        <FeaturesSection v-show="tab === 'features' && !worldState.active" />
        <WorldSection />
        <ViewSection />
        <SlicersSection />
        <SceneSection />
      </template>
    </aside>
    <main class="viewport">
      <canvas id="view" ref="canvasEl"></canvas>
      <!-- walking hides the viewport chrome: only the crosshair + hint show -->
      <template v-if="!walkState.on">
        <div v-if="current.error" class="chip error">{{ current.error }}</div>
        <div v-else-if="current.reading && !minimal" class="chip">{{ current.reading.label || "reading structures" }}… {{ current.reading.done }}/{{ current.reading.total }}</div>
        <div v-else-if="buildState.status && !minimal" class="chip">{{ buildState.status }}</div>
        <div v-else-if="info" class="chip">{{ info }}</div>
        <div v-if="packsState.remoteError" class="chip error remote">{{ packsState.remoteError }}</div>
        <div v-if="!current.error && aim" class="chip aim">{{ aim }}</div>
        <LevelMenu v-if="!minimal" />
        <button v-if="(buildState.building || current.reading) && cancelReady" class="cancel-btn" @click="current.reading ? cancelReading() : cancelBuild()">
          <span class="material-symbols-outlined">close</span>
          Cancel
        </button>
        <button v-if="!minimal" class="walk-btn" :disabled="locked || !buildState.info" @click="walkClick()">
          <span class="material-symbols-outlined">directions_walk</span>
          Walk Around
        </button>
        <div v-if="walkMenu" class="walk-menu">
          <button @click="walkMenu = false; walk.enter()">
            <span class="material-symbols-outlined">deployed_code</span>
            Explore this scene
          </button>
          <button @click="walkStream()">
            <span class="material-symbols-outlined">public</span>
            Stream the world
          </button>
        </div>
        <button v-if="buildState.info && (buildState.info.blocks || structure?.entities?.length)" class="used-btn" :disabled="locked" @click="usedModal?.open()">
          <span class="material-symbols-outlined">list_alt</span>
          {{ usedLabel }}
        </button>
      </template>
      <WalkOverlay />
      <div v-if="stream.state.preparing" class="stream-preparing">
        <svg class="spinner" viewBox="0 0 24 24" width="30" height="30" aria-label="Loading">
          <circle cx="12" cy="12" r="10" fill="none" stroke="#ffffff1f" stroke-width="3"/>
          <path d="M12 2 a 10 10 0 0 1 10 10" fill="none" stroke="#4c8dff" stroke-width="3" stroke-linecap="round"/>
        </svg>
        <p>{{ stream.state.preparing === "restore" ? "Restoring scene…" : "Preparing world…" }}</p>
      </div>
      <FpsCounter v-if="!minimal" />
      <UsedBlocksModal ref="usedModal" />
      <ContainerModal />
      <ContextMenu />
      <BuildProgress />
      <BuildWarning />
      <div v-if="!minimalReady" class="splash-overlay">
        <h1>Structure Viewer</h1>
        <template v-if="notFound">
          <p class="splash-error">{{ notFound }}</p>
          <a class="splash-link" :href="homeUrl" target="_blank" rel="noopener">Open the full site</a>
        </template>
        <template v-else-if="splashCancelled">
          <p>View every Minecraft structure and worldgen feature in 3D, from village pieces to whole strongholds and trees to geodes, and test out how they generate with re-rollable seeds.</p>
          <p>Load your own structures and world saves, apply resource packs, mods, and datapacks, combine structures into one scene, and share anything with a link.</p>
          <a class="splash-link" :href="mainSiteUrl" target="_blank" rel="noopener" @pointerdown="refreshMainSiteUrl">Open the full site</a>
        </template>
        <template v-else>
          <p v-if="splashName" class="splash-name">Opening: {{ splashName }}</p>
          <template v-else>
            <p>View every Minecraft structure and worldgen feature in 3D, from village pieces to whole strongholds and trees to geodes, and test out how they generate with re-rollable seeds.</p>
            <p>Load your own structures and world saves, apply resource packs, mods, and datapacks, combine structures into one scene, and share anything with a link.</p>
          </template>
          <svg class="spinner" viewBox="0 0 24 24" width="30" height="30" aria-label="Loading">
            <circle cx="12" cy="12" r="10" fill="none" stroke="#ffffff1f" stroke-width="3"/>
            <path d="M12 2 a 10 10 0 0 1 10 10" fill="none" stroke="#4c8dff" stroke-width="3" stroke-linecap="round"/>
          </svg>
          <p class="splash-status">{{ splashStatus }}</p>
          <button v-if="(buildState.building || current.reading) && cancelReady" class="splash-cancel" @click="splashCancel">Cancel</button>
        </template>
      </div>
      <button v-if="minimal && minimalReady && fullscreenSupported" class="fs-btn" :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'" @click="toggleFullscreen">
        <span class="material-symbols-outlined">{{ isFullscreen ? "fullscreen_exit" : "fullscreen" }}</span>
      </button>
      <a v-if="minimal && minimalReady" class="open-full" :href="mainSiteUrl" target="_blank" rel="noopener" title="Open in Structure Viewer" @pointerdown="refreshMainSiteUrl">
        <span class="material-symbols-outlined">open_in_new</span>
      </a>
      <Modal v-if="notFound && !minimal" :width="380" :z="250" class="nf" @close="notFound = ''">
        <h3>Structure not found</h3>
        <p>{{ notFound }}</p>
      </Modal>
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100%;
}

.sidebar {
  width: 300px;
  flex-shrink: 0;
  background: var(--panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.app-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.app-head h1 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.lib-error {
  padding: 10px 14px;
  color: var(--red);
  font-size: 13px;
}

.viewport {
  flex: 1;
  min-width: 0;
  position: relative;
}

#view {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.chip {
  position: absolute;
  top: 12px;
  left: 14px;
  max-width: calc(100% - 28px);
  box-sizing: border-box;
  background: #000000a0;
  color: var(--text-dim);
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12px;
  pointer-events: none;
}

.chip.error { color: var(--red); }

.chip.remote { top: 44px; }

.chip.aim {
  top: 44px;
  font-family: ui-monospace, monospace;
}

.chip.remote ~ .chip.aim { top: 76px; }

.walk-btn {
  position: absolute;
  left: 14px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.walk-btn .material-symbols-outlined { font-size: 18px; }

.walk-menu {
  position: absolute;
  left: 14px;
  bottom: 52px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  background: #222227;
  border: 1px solid #333338;
  border-radius: 8px;
  z-index: 5;
}

.walk-menu button {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-start;
}

.walk-menu .material-symbols-outlined { font-size: 18px; }

.used-btn {
  position: absolute;
  left: 14px;
  bottom: 52px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* no walk button to stack above in minimal mode */
.minimal .used-btn { bottom: 12px; }

.splash-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  background: var(--bg);
  color: #9a9aa5;
  text-align: center;
}

.stream-preparing {
  position: absolute;
  inset: 0;
  z-index: 35;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--bg);
  color: #9a9aa5;
}

.stream-preparing .spinner {
  animation: spin 0.9s linear infinite;
}

.stream-preparing p {
  margin: 0;
}

.splash-overlay h1 {
  margin: 0;
  font-size: 34px;
  color: #e8e8ec;
}

.splash-overlay p {
  margin: 0;
  max-width: 560px;
  line-height: 1.6;
}

.splash-overlay .spinner {
  margin-top: 10px;
  animation: spin 0.9s linear infinite;
}

.splash-overlay .splash-name {
  color: #c9c9d2;
}

.splash-overlay .splash-error {
  color: var(--red);
}

.splash-overlay .splash-link {
  margin-top: 10px;
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  text-decoration: none;
}

.splash-overlay .splash-link:hover { background: #2e2e36; }

.splash-overlay .splash-cancel {
  margin-top: 6px;
}

.open-full {
  position: absolute;
  top: 12px;
  right: 14px;
  z-index: 50;
  display: flex;
  padding: 6px;
  color: var(--text-dim);
  text-decoration: none;
}

.open-full:hover { color: var(--text); }

.fs-btn {
  position: absolute;
  right: 14px;
  bottom: 12px;
  z-index: 50;
  display: flex;
  padding: 6px;
  background: none;
  border: none;
  color: var(--text-dim);
}

.fs-btn:hover:not(:disabled) {
  background: none;
  color: var(--text);
}

.fs-btn .material-symbols-outlined { font-size: 24px; }

.open-full .material-symbols-outlined { font-size: 24px; }

.nf :deep(.modal-panel) {
  padding: 18px 20px;
}

.nf h3 {
  margin: 0 0 8px;
  font-size: 15px;
}

.nf p {
  margin: 0;
  color: var(--text-dim);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.splash-overlay .splash-status {
  font-size: 13px;
  color: #6f6f7a;
  font-variant-numeric: tabular-nums;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.used-btn .material-symbols-outlined { font-size: 18px; }

.cancel-btn {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
}

.cancel-btn .material-symbols-outlined {
  font-size: 18px;
  color: var(--red);
}
</style>
