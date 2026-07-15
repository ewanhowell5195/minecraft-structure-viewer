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
import { useWorld } from "./composables/useWorld.js"
import { restoreFile } from "./userCache.js"
import { useContainer } from "./composables/useContainer.js"
import { useSlicers } from "./composables/useSlicers.js"
import { tab } from "./composables/useTab.js"
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

const libError = ref("")
const canvasEl = ref(null)
const usedModal = ref(null)
const { loadBase, restoreCachedPacks } = usePacks()
const structures = useStructures()
const { state: current, structure, loadVanilla, loadDefault, loadMany, loadFile, loadDebug, loadFeature, loadFeatures, loadFeatureField, cancelReading } = useStructure()
const { state: buildState, cancel: cancelBuild } = useBuild()
const sceneApi = useScene()
const walk = useWalk()
const walkState = walk.state
const { locked } = useLock()
const { state: containerState } = useContainer()

const fmtK = n => n >= 1000 ? +(n / 1000).toFixed(1) + "K" : String(Math.round(n))

const info = computed(() => {
  const i = buildState.info
  if (!i) return ""
  const name = current.name ? `${current.name} · ` : ""
  return `${name}${i.size} · ${i.blocks} blocks · ${i.palette} palette entries · ${i.draws} draws · ${fmtK(i.tris)} tris`
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
  const stop = watch(() => structures.state.names.length, async n => {
    if (!n) return
    stop()
    // startup restores must never drop the cache: a reload landing on a stale
    // ?structure= url would otherwise wipe the file the user expects back
    beginInit()
    try {
      // the world restores first so its structures resolve for the param filter below
      const worldFile = await restoreFile("world")
      if (worldFile) await useWorld().openWorld(worldFile, false)
      const rels = (await decodeStructureParam(structureParam)).filter(r => structures.has(r))
      const structureFile = rels.length || debug != null || feature != null ? null : await restoreFile("structure")
      if (debug != null) await loadDebug(debug)
      else if (feature != null && feature.includes(",")) await loadFeatures(feature.split(","))
      else if (feature != null && params.get("field") != null) await loadFeatureField(feature, parseSeedParam(params.get("fseed")))
      else if (feature != null) await loadFeature(feature, parseSeedParam(params.get("fseed")))
      else if (rels.length > 1) await loadMany(rels)
      else if (rels.length === 1) await loadVanilla(rels[0])
      else if (structureFile) await loadFile(structureFile, false)
      else await loadDefault()
    } finally {
      endInit()
    }
    useSlicers().restoreUrlSlice()
  })
  await restoreCachedPacks()
  await loadBase()
})
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <header class="app-head">
        <span class="material-symbols-outlined">deployed_code</span>
        <h1>Structure Viewer</h1>
      </header>
      <div v-if="libError" class="lib-error">Renderer failed: {{ libError }}</div>
      <template v-else>
        <PacksSection />
        <StructuresSection v-show="tab === 'structures'" />
        <FeaturesSection v-show="tab === 'features'" />
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
        <div v-else-if="current.reading" class="chip">reading structures… {{ current.reading.done }}/{{ current.reading.total }}</div>
        <div v-else-if="buildState.status" class="chip">{{ buildState.status }}</div>
        <div v-else-if="info" class="chip">{{ info }}</div>
        <div v-if="!current.error && aim" class="chip aim">{{ aim }}</div>
        <LevelMenu />
        <button v-if="buildState.building || current.reading" class="cancel-btn" @click="current.reading ? cancelReading() : cancelBuild()">
          <span class="material-symbols-outlined">close</span>
          Cancel
        </button>
        <button class="walk-btn" :disabled="locked || !buildState.info" @click="walk.enter()">
          <span class="material-symbols-outlined">directions_walk</span>
          Walk Around
        </button>
        <button v-if="buildState.info && (buildState.info.blocks || structure?.entities?.length)" class="used-btn" :disabled="locked" @click="usedModal?.open()">
          <span class="material-symbols-outlined">list_alt</span>
          {{ usedLabel }}
        </button>
      </template>
      <WalkOverlay />
      <FpsCounter />
      <UsedBlocksModal ref="usedModal" />
      <ContainerModal />
      <ContextMenu />
      <BuildProgress />
      <BuildWarning />
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
  background: #000000a0;
  color: var(--text-dim);
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12px;
  pointer-events: none;
}

.chip.error { color: var(--red); }

.chip.aim {
  top: 44px;
  font-family: ui-monospace, monospace;
}

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
