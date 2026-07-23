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
import SplashScreen from "./components/SplashScreen.vue"
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
async function walkClick() {
  if (stream.state.session) {
    walk.prelock()
    if (await stream.enter()) walk.enter()
    else if (document.pointerLockElement) document.exitPointerLock()
    return
  }
  walk.enter()
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

// one splash screen, many states: minimal-mode landing/progress/error and the
// stream world-prepare screen all reduce to a SplashScreen config here
const splash = computed(() => {
  if (!minimalReady.value) {
    if (notFound.value) return { error: notFound.value, link: { label: "Open the full site", href: homeUrl } }
    if (splashCancelled.value) return { blurb: true, link: { label: "Open the full site", href: mainSiteUrl.value } }
    return {
      name: splashName.value,
      blurb: !splashName.value,
      spinner: true,
      status: splashStatus.value,
      cancel: (buildState.building || !!current.reading) && cancelReady.value
    }
  }
  if (stream.state.preparing) {
    return {
      spinner: true,
      status: stream.state.prepMsg || "Preparing world\u2026",
      note: "You may experience some lag shortly after loading in while the nearby chunks stream in."
    }
  }
  return null
})

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
      // a bare wy (saved by explore world) restores the sliders without a build
      if (worldFile && params.get("wy")) {
        const [lo, hi] = params.get("wy").split(",").map(Number)
        if (Number.isFinite(lo) && Number.isFinite(hi)) useWorld().setYRange(lo, hi)
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
        <button v-if="buildState.info && (buildState.info.blocks || structure?.entities?.length)" class="used-btn" :disabled="locked" @click="usedModal?.open()">
          <span class="material-symbols-outlined">list_alt</span>
          {{ usedLabel }}
        </button>
      </template>
      <WalkOverlay />
      <FpsCounter v-if="!minimal" />
      <UsedBlocksModal ref="usedModal" />
      <ContainerModal />
      <ContextMenu />
      <BuildProgress />
      <BuildWarning />
      <SplashScreen v-if="splash" v-bind="splash" @cancel="splashCancel" @linkdown="refreshMainSiteUrl" />
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
