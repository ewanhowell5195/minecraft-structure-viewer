<script setup>
import { computed, onMounted, ref, watch } from "vue"
import { loadLibrary } from "./lib.js"
import { usePacks } from "./composables/usePacks.js"
import { useStructures } from "./composables/useStructures.js"
import { useStructure, decodeStructureParam, parseSeedParam, beginInit, endInit } from "./composables/useStructure.js"
import { useBuild } from "./composables/useBuild.js"
import { useScene } from "./composables/useScene.js"
import { useSky } from "./composables/useSky.js"
import { useCompare } from "./composables/useCompare.js"
import { useComparePacks } from "./composables/useComparePacks.js"
import { useLock } from "./composables/useLock.js"
import { useFullscreen } from "./composables/useFullscreen.js"
import { useWalk } from "./composables/useWalk.js"
import { useStream } from "./composables/useStream.js"
import { useWorld } from "./composables/useWorld.js"
import { restoreFile, cacheFile, uncache } from "./userCache.js"
import { useContainer } from "./composables/useContainer.js"
import { useSlicers } from "./composables/useSlicers.js"
import { tab } from "./composables/useTab.js"
import { minimal } from "./minimal.js"
import { manual } from "./manual.js"
import { setParams } from "./params.js"
import { offerHandoff, receiveHandoff } from "./handoff.js"
import { initEmbedApi, emit } from "./embed.js"
import { isRemote, prefetchRemote } from "./remote.js"
import { compareChanges } from "./compareChanges.js"
import { routeFiles } from "./fileroute.js"
import { writeZip } from "minecraft-asset-loader"
import { kilo, num } from "./format.js"
import PacksSection from "./components/PacksSection.vue"
import CompareSection from "./components/CompareSection.vue"
import StructuresSection from "./components/StructuresSection.vue"
import FeaturesSection from "./components/FeaturesSection.vue"
import WorldSection from "./components/WorldSection.vue"
import ViewSection from "./components/ViewSection.vue"
import EnvironmentSection from "./components/EnvironmentSection.vue"
import SlicersSection from "./components/SlicersSection.vue"
import SceneSection from "./components/SceneSection.vue"
import LevelMenu from "./components/LevelMenu.vue"
import WalkOverlay from "./components/WalkOverlay.vue"
import FindOverlay from "./components/FindOverlay.vue"
import CompareOverlay from "./components/CompareOverlay.vue"
import FpsCounter from "./components/FpsCounter.vue"
import ContainerModal from "./components/ContainerModal.vue"
import UsedBlocksModal from "./components/UsedBlocksModal.vue"
import DebugModal from "./components/DebugModal.vue"
import ContextMenu from "./components/ContextMenu.vue"
import BuildProgress from "./components/BuildProgress.vue"
import SplashScreen from "./components/SplashScreen.vue"
import BuildWarning from "./components/BuildWarning.vue"
import Modal from "./components/Modal.vue"

const libError = ref("")
const canvasEl = ref(null)
const usedModal = ref(null)
const { loadBase, initSources, restoreCachedPacks, addUrlPacks, state: packsState } = usePacks()
const structures = useStructures()
const { state: current, structure, loadVanilla, loadDefault, loadMany, loadFile, loadDebug, loadFeature, loadFeatures, loadFeatureField, cancelReading } = useStructure()
const { state: buildState, cancel: cancelBuild } = useBuild()
const sceneApi = useScene()
const sky = useSky()
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
const compareState = useCompare().state
const { locked } = useLock()

const dropping = ref(false)
const reading = ref(null)
let dragDepth = 0
const dragHasFiles = e => Array.from(e.dataTransfer?.types ?? []).includes("Files")

if (!minimal) onMounted(() => {
  addEventListener("dragenter", e => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    if (++dragDepth === 1) dropping.value = !locked.value && !reading.value
  })
  addEventListener("dragover", e => {
    if (dragHasFiles(e)) e.preventDefault()
  })
  addEventListener("dragleave", e => {
    if (!dragHasFiles(e) || --dragDepth > 0) return
    dragDepth = 0
    dropping.value = false
  })
  addEventListener("drop", async e => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    dropping.value = false
    if (locked.value || reading.value) return
    let files
    try {
      files = await droppedFiles(e.dataTransfer, (label, progress, count) => { reading.value = { label, progress, count } })
    } finally {
      reading.value = null
    }
    if (files.length) routeFiles(files)
  })
})

// entry handles must be taken before awaiting
async function droppedFiles(dt, onProgress) {
  const entries = Array.from(dt.items ?? [], item => item.webkitGetAsEntry?.()).filter(Boolean)
  if (!entries.length) return Array.from(dt.files)
  const out = []
  for (const entry of entries) {
    if (entry.isFile) {
      const f = await entryFile(entry)
      if (f) out.push(f)
      continue
    }
    if (!entry.isDirectory) continue
    onProgress(`Listing ${entry.name}…`, 0)
    const listed = []
    await walkEntry(entry, entry.fullPath.length + 1, listed)
    const total = listed.reduce((n, l) => n + l.file.size, 0) || 1
    let done = 0
    const files = new Map()
    for (const { name, file } of listed) {
      files.set(name, new Uint8Array(await file.arrayBuffer()))
      done += file.size
      onProgress(`Reading ${entry.name}…`, done / total, `${files.size}/${listed.length} files`)
    }
    onProgress(`Packing ${entry.name}…`, 1)
    out.push(new File([await writeZip(files)], entry.name + "/", { type: "application/zip" }))
  }
  return out
}

const entryFile = entry => new Promise(resolve => entry.file(resolve, () => resolve(null)))

async function walkEntry(entry, rootLen, out) {
  if (entry.isFile) {
    const file = await entryFile(entry)
    if (file) out.push({ name: entry.fullPath.slice(rootLen), file })
    return
  }
  if (!entry.isDirectory || entry.name === ".git") return
  const reader = entry.createReader()
  for (;;) {
    const batch = await new Promise(resolve => reader.readEntries(resolve, () => resolve([])))
    if (!batch.length) return
    for (const e of batch) await walkEntry(e, rootLen, out)
  }
}
const { state: containerState } = useContainer()

const worldState = useWorld().state

const minimalReady = ref(!minimal)
const notFound = ref("")
const debugPicker = ref(false)

const drawer = ref("")
const toggleDrawer = side => { drawer.value = drawer.value === side ? "" : side }
const closeOnPick = e => { if (e.target.closest(".tree-file")) drawer.value = "" }
// refreshed on pointerdown so the link always carries the current url state
const mainSiteUrl = ref("")
const homeUrl = location.origin + location.pathname
function refreshMainSiteUrl() {
  const u = new URL(location.href)
  u.searchParams.delete("minimal")
  u.searchParams.delete("manual")
  const base = useComparePacks().state.baseId
  if (useCompare().getFiles().panel && base && !u.searchParams.get("cversion")) u.searchParams.set("cversion", base)
  if (minimal) u.searchParams.set("handoff", "1")
  mainSiteUrl.value = u.href
}
refreshMainSiteUrl()

if (minimal) offerHandoff(() => {
  const files = useCompare().getFiles()
  return {
    structure: files.main ?? useStructure().currentFile(),
    world: worldState.active ? useWorld().getWorldFile() : null,
    compare: files.panel
  }
})

const { supported: fullscreenSupported, active: isFullscreen, toggle: toggleFullscreen } = useFullscreen()

watch(() => !!buildState.info || !!current.error, ready => {
  if (ready) minimalReady.value = true
}, { immediate: true })

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
  // manual embeds have no blurb to fall back to: the parent drives everything,
  // so an idle viewer is waiting rather than cancelled
  if (!minimal || manual || minimalReady.value || !sawLoad) return
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

const working = computed(() => packsState.busy || buildState.building || !!current.reading || !!buildState.status)

// an embedding page's commands arrive with millisecond gaps between them, so
// the waiting state only returns after a quiet second, and the last step is
// held up across the gaps rather than flickering through the fallbacks
const idle = ref(true)
const heldStatus = ref("")
let idleTimer = null

const splash = computed(() => {
  if (!minimalReady.value) {
    if (notFound.value) return { error: notFound.value, link: { label: "Open the full site", href: homeUrl } }
    if (splashCancelled.value) return { blurb: true, link: { label: "Open the full site", href: mainSiteUrl.value } }
    if (manual && !working.value) {
      if (idle.value) return { status: "Waiting for the embedding page…" }
      return { name: splashName.value, spinner: true, status: heldStatus.value }
    }
    return {
      name: splashName.value,
      blurb: !splashName.value && !manual,
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

watch([working, splashStatus], ([w, s]) => {
  clearTimeout(idleTimer)
  if (w) {
    idle.value = false
    heldStatus.value = s
    return
  }
  idleTimer = setTimeout(() => {
    idle.value = true
    heldStatus.value = ""
  }, 1000)
})

function stats(i) {
  const perf = minimal ? "" : ` · ${i.draws} draws · ${kilo(i.tris)} tris`
  return `${i.size} · ${num(i.blocks)} blocks, ${num(i.palette)} unique${perf}`
}

const rightInfo = computed(() => compareState.on && buildState.info ? stats(buildState.info) : "")

const SKY_FOG = { overworld: "#C0D8FF", the_nether: "#330808", the_end: "#181318" }
const skyBg = computed(() => sky.active.value ? SKY_FOG[sky.skyDim.value] ?? SKY_FOG.overworld : "")

const info = computed(() => {
  const i = compareState.on ? (compareState.view === "after" ? buildState.info : compareState.leftInfo) : buildState.info
  if (!i) return ""
  if (compareState.on) return stats(i)
  const name = current.name ? `${current.name.replace(/\//g, "/\u200B")} · ` : ""
  return name + stats(i)
})

const compareTag = computed(() => compareState.view === "after" ? compareState.right : compareState.left)

const usedLabel = computed(() => {
  if (compareState.on) {
    const d = compareChanges(useCompare().leftStructure(), structure.value)
    return !(d.blocks.length + d.changed.blocks.length) && d.entities.length + d.changed.entities.length ? "Entities" : "Blocks"
  }
  return buildState.info?.blocks === 0 && structure.value?.entities?.length ? "Entities" : "Blocks"
})

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
  const params = new URLSearchParams(location.search)
  const structureParam = params.get("structure")
  const debug = params.get("debug")
  const feature = params.get("feature")
  const requested = await decodeStructureParam(structureParam)
  prefetchRemote(requested.filter(isRemote))
  const stop = watch(() => structures.state.names.length, async n => {
    if (!n || manual) return
    stop()
    if (locked.value) await new Promise(resolve => {
      const unwatch = watch(locked, v => { if (!v) { unwatch(); resolve() } })
    })
    beginInit()
    try {
      if (params.has("handoff") && !minimal) {
        const handed = await receiveHandoff()
        if (handed) for (const kind of ["structure", "world", "compare"]) {
          await (handed[kind] ? cacheFile(kind, handed[kind]) : uncache(kind))
        }
        setParams({ handoff: null })
      }
      const cversion = minimal || manual ? null : params.get("cversion")
      if (cversion) uncache("world")
      // the world restores first so its structures resolve for the param filter below
      // (minimal embeds ignore all cached user files and load fresh from the URL)
      const worldFile = minimal || cversion ? null : await restoreFile("world")
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
      if (debug === "") debugPicker.value = true
      else if (debug != null) await loadDebug(debug)
      else if (feature != null && feature.includes(",")) await loadFeatures(feature.split(","))
      else if (feature != null && params.get("field") != null) await loadFeatureField(feature, parseSeedParam(params.get("fseed")))
      else if (feature != null) await loadFeature(feature, parseSeedParam(params.get("fseed")))
      else if (rels.length > 1 || rels.some(isRemote)) await loadMany(rels)
      else if (rels.length === 1) await loadVanilla(rels[0])
      else if (structureFile && !cversion) await loadFile(structureFile, false)
      else if (!(minimal && notFound.value) && !(structureFile && cversion)) await loadDefault()
      // an armed panel owns comparison, so a stale ?compare= pair is ignored
      const against = params.get("compare")
      if (cversion) {
        useSlicers().restoreUrlSlice()
        await useComparePacks().fromParam(cversion)
        // a structure only the compared version has resolves once its jar is in
        if (!rels.length && requested.length === 1 && useComparePacks().has(requested[0])) {
          notFound.value = ""
          await useCompare().openVersion(requested[0])
        }
        // restored files have no path to look up, so they are fed in as uploads
        const panelFile = await restoreFile("compare")
        if (structureFile || panelFile) await useCompare().setFiles(structureFile, panelFile)
      } else if (against && rels.length === 1 && structures.has(against)) {
        useSlicers().restoreUrlSlice()
        await useCompare().enter(against)
      }
    } finally {
      endInit()
    }
    useSlicers().restoreUrlSlice()
  })
  const packUrls = (params.get("packs") ?? "").split(",").filter(Boolean)
  const urlPacks = packUrls.length ? addUrlPacks(packUrls) : undefined
  if (manual) await initSources(urlPacks)
  else {
    if (!minimal) await restoreCachedPacks()
    await loadBase(undefined, urlPacks)
  }
  initEmbedApi()
})
</script>

<template>
  <div class="layout" :class="{ minimal, 'drawer-left': drawer === 'left', 'drawer-right': drawer === 'right' }">
    <div v-if="dropping || reading" class="drop-veil">
      <div class="drop-card" :class="{ reading }">
        <span class="material-symbols-outlined" :class="{ spin: reading }">{{ reading ? "progress_activity" : "upload_file" }}</span>
        <div>{{ reading?.label ?? "Drop to open" }}</div>
        <span v-if="reading?.count" class="count">{{ reading.count }}</span>
        <div v-if="reading" class="loadbar"><div class="fill" :style="{ width: reading.progress * 100 + '%' }"></div></div>
      </div>
    </div>
    <aside v-if="!minimal" class="sidebar" @click="closeOnPick">
      <header class="app-head">
        <span class="material-symbols-outlined">deployed_code</span>
        <h1>Structure Viewer</h1>
      </header>
      <div v-if="libError" class="lib-error">Renderer failed: {{ libError }}</div>
      <template v-else>
        <PacksSection />
        <StructuresSection v-show="tab !== 'features' && !worldState.active" />
        <FeaturesSection v-show="tab === 'features' && !worldState.active" />
        <WorldSection />
        <CompareSection v-show="!worldState.active" />
      </template>
    </aside>
    <main class="viewport" :style="skyBg ? { background: skyBg } : null">
      <canvas id="view" ref="canvasEl"></canvas>
      <template v-if="!walkState.on">
        <div class="topbar">
          <div v-if="compareState.on" class="name-tag">{{ compareTag }}</div>
          <div v-if="current.error" class="chip error">{{ current.error }}</div>
          <div v-else-if="current.reading && !minimal" class="chip">{{ current.reading.label || "reading structures" }}… {{ current.reading.done }}/{{ current.reading.total }}</div>
          <div v-else-if="buildState.status && !minimal" class="chip">{{ buildState.status }}</div>
          <div v-else-if="info" class="chip">{{ info }}</div>
        </div>
        <div v-if="compareState.on && compareState.view === 'slide'" class="topbar right">
          <div v-if="rightInfo" class="chip">{{ rightInfo }}</div>
          <div class="name-tag">{{ compareState.right }}</div>
        </div>
        <div v-if="packsState.remoteError" class="chip error remote">{{ packsState.remoteError }}</div>
        <div v-if="!current.error && aim" class="chip aim">{{ aim }}</div>
        <LevelMenu v-if="!minimal && !compareState.on" />
        <button v-if="(buildState.building || current.reading) && cancelReady" class="cancel-btn float-btn" @click="current.reading ? cancelReading() : cancelBuild()">
          <span class="material-symbols-outlined">close</span>
          <span class="label">Cancel</span>
        </button>
        <button v-if="!minimal && !compareState.on" class="walk-btn float-btn" :disabled="locked || !buildState.info" @click="walkClick()">
          <span class="material-symbols-outlined">directions_walk</span>
          <span class="label">Walk Around</span>
        </button>
        <button v-if="buildState.info && (buildState.info.blocks || structure?.entities?.length || compareState.on)" class="used-btn float-btn" :class="{ solo: compareState.on }" :disabled="locked" @click="usedModal?.open()">
          <span class="material-symbols-outlined">list_alt</span>
          <span class="label">{{ usedLabel }}</span>
        </button>
        <FindOverlay />
        <CompareOverlay />
      </template>
      <WalkOverlay />
      <FpsCounter v-if="!minimal && !compareState.on" />
      <UsedBlocksModal ref="usedModal" />
      <ContainerModal />
      <DebugModal v-if="debugPicker" @close="debugPicker = false" />
      <ContextMenu />
      <BuildProgress />
      <BuildWarning />
      <SplashScreen v-if="splash" v-bind="splash" @cancel="splashCancel" @linkdown="refreshMainSiteUrl" />
      <button v-if="minimal && minimalReady && fullscreenSupported" class="fs-btn" :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'" @click="toggleFullscreen()">
        <span class="material-symbols-outlined">{{ isFullscreen ? "fullscreen_exit" : "fullscreen" }}</span>
      </button>
      <a v-if="minimal && minimalReady" class="open-full" title="Open in Structure Viewer" :href="mainSiteUrl" target="_blank" rel="opener" @pointerdown="refreshMainSiteUrl">
        <span class="material-symbols-outlined">open_in_new</span>
      </a>
      <Modal v-if="notFound && !minimal" :width="380" :z="250" class="nf" @close="notFound = ''">
        <h3>Structure not found</h3>
        <p>{{ notFound }}</p>
      </Modal>
    </main>
    <aside v-if="!minimal && !libError" class="sidebar right">
      <ViewSection />
      <EnvironmentSection />
      <SlicersSection />
      <SceneSection />
    </aside>
    <template v-if="!minimal">
      <button class="drawer-toggle left" title="Structures" @click="toggleDrawer('left')">
        <span class="material-symbols-outlined">menu</span>
      </button>
      <button v-if="!libError" class="drawer-toggle right" title="View settings" @click="toggleDrawer('right')">
        <span class="material-symbols-outlined">tune</span>
      </button>
      <div v-if="drawer" class="backdrop" @click="drawer = ''"></div>
    </template>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100%;
}

.drop-veil {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0009;
  backdrop-filter: blur(2px);
  pointer-events: none;
}

.drop-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  padding: 18px 26px;
  border-radius: 10px;
  border: 2px dashed var(--accent);
  background: var(--panel);
  color: var(--text);
  font-weight: 600;
  user-select: none;
}

.drop-card.reading { min-width: 300px; }

.drop-card .count {
  font-family: ui-monospace, monospace;
  font-weight: 400;
  color: var(--text-dim);
}

.drop-card .loadbar { align-self: stretch; }

.drop-card .material-symbols-outlined { font-size: 26px; }

.drop-card .spin { animation: spin 1s linear infinite; }

@keyframes spin { to { transform: rotate(360deg); } }

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

.sidebar.right {
  border-right: none;
  border-left: 1px solid var(--border);
}

.drawer-toggle {
  display: none;
  position: fixed;
  top: 12px;
  z-index: 28;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: #1f1f25d9;
}

.drawer-toggle.left { left: 12px; }
.drawer-toggle.right { right: 12px; }
.drawer-toggle .material-symbols-outlined { font-size: 20px; }

.backdrop { display: none; }

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
  outline: none;
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

.topbar {
  position: absolute;
  top: 12px;
  left: 14px;
  max-width: calc(100% - 28px);
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.topbar.right {
  left: auto;
  right: 14px;
}

/* room for the open-in-viewer link in the corner */
.minimal .topbar.right { right: 44px; }

.topbar .chip {
  position: static;
  max-width: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
}

.used-btn {
  position: absolute;
  left: 14px;
  bottom: 52px;
}

/* no walk button to stack above in minimal or compare mode */
.minimal .used-btn,
.used-btn.solo { bottom: 12px; }

.open-full {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 50;
  display: flex;
  padding: 6px;
  color: var(--text-dim);
  text-decoration: none;
  cursor: pointer;
  user-select: none;
}

.open-full:hover { color: var(--text); }

.fs-btn {
  position: absolute;
  right: 6px;
  bottom: 6px;
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

.cancel-btn {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
}

.cancel-btn .material-symbols-outlined { color: var(--red); }

@media (max-width: 900px) {
  .sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 30;
    width: min(300px, 85vw);
    transform: translateX(-100%);
    transition: transform 0.25s;
  }

  .sidebar.right {
    left: auto;
    right: 0;
    transform: translateX(100%);
  }

  .drawer-left .sidebar:not(.right),
  .drawer-right .sidebar.right {
    transform: none;
    box-shadow: 0 0 30px #00000080;
  }

  .drawer-toggle { display: flex; }

  .backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 29;
    background: #00000073;
  }

  /* clear of the drawer toggles */
  .chip {
    left: 60px;
    max-width: calc(100% - 120px);
  }

  .cancel-btn { top: 56px; }

  .viewport :deep(.fps) { right: 60px; }
}
</style>
