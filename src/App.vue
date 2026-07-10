<script setup>
import { computed, onMounted, ref, watch } from "vue"
import { loadLibrary } from "./lib.js"
import { usePacks } from "./composables/usePacks.js"
import { useStructures } from "./composables/useStructures.js"
import { useStructure, decodeVanillaParam } from "./composables/useStructure.js"
import { useBuild } from "./composables/useBuild.js"
import { useScene } from "./composables/useScene.js"
import { useLock } from "./composables/useLock.js"
import { useWalk } from "./composables/useWalk.js"
import { useContainer } from "./composables/useContainer.js"
import PacksSection from "./components/PacksSection.vue"
import StructuresSection from "./components/StructuresSection.vue"
import ViewSection from "./components/ViewSection.vue"
import SceneSection from "./components/SceneSection.vue"
import LevelMenu from "./components/LevelMenu.vue"
import WalkOverlay from "./components/WalkOverlay.vue"
import FpsCounter from "./components/FpsCounter.vue"
import ContainerModal from "./components/ContainerModal.vue"
import ContextMenu from "./components/ContextMenu.vue"
import BuildProgress from "./components/BuildProgress.vue"

const libError = ref("")
const canvasEl = ref(null)
const { loadBase } = usePacks()
const structures = useStructures()
const { state: current, structure, loadVanilla, loadMany, loadDebug } = useStructure()
const { state: buildState, cancel: cancelBuild } = useBuild()
const sceneApi = useScene()
const walk = useWalk()
const walkState = walk.state
const { locked } = useLock()

const fmtK = n => n >= 1000 ? +(n / 1000).toFixed(1) + "K" : String(Math.round(n))

const info = computed(() => {
  const i = buildState.info
  if (!i) return ""
  const name = current.name ? `${current.name} · ` : ""
  return `${name}${i.size} · ${i.blocks} blocks · ${i.palette} palette entries · ${i.draws} draws · ${fmtK(i.tris)} tris`
})

onMounted(async () => {
  try {
    await loadLibrary()
  } catch (err) {
    libError.value = String(err)
    return
  }
  sceneApi.init(canvasEl.value)
  useContainer().initPicking(canvasEl.value)
  // load the requested structure (?debug = the generated mesher test scene),
  // or a default so the page never starts empty
  const DEFAULT = "minecraft/village/plains/houses/plains_small_house_1"
  const params = new URLSearchParams(location.search)
  const vanilla = params.get("vanilla")
  const debug = params.get("debug")
  const stop = watch(() => structures.state.names.length, async n => {
    if (!n) return
    stop()
    const rels = (await decodeVanillaParam(vanilla)).filter(r => structures.has(r))
    if (debug != null) loadDebug(debug)
    else if (rels.length > 1) loadMany(rels)
    else if (rels.length === 1) loadVanilla(rels[0])
    else if (structures.has(DEFAULT)) loadVanilla(DEFAULT)
  })
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
        <StructuresSection />
        <ViewSection />
        <SceneSection />
      </template>
    </aside>
    <main class="viewport">
      <canvas id="view" ref="canvasEl"></canvas>
      <!-- walking hides the viewport chrome: only the crosshair + hint show -->
      <template v-if="!walkState.on">
        <div v-if="current.error" class="chip error">{{ current.error }}</div>
        <div v-else-if="buildState.status" class="chip">{{ buildState.status }}</div>
        <div v-else-if="info" class="chip">{{ info }}</div>
        <LevelMenu />
        <button v-if="buildState.building" class="cancel-btn" @click="cancelBuild()">
          <span class="material-symbols-outlined">close</span>
          Cancel
        </button>
        <button class="walk-btn" :disabled="locked || !buildState.info" @click="walk.enter()">
          <span class="material-symbols-outlined">directions_walk</span>
          Walk Around
        </button>
      </template>
      <WalkOverlay />
      <FpsCounter />
      <ContainerModal />
      <ContextMenu />
      <BuildProgress />
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

.walk-btn {
  position: absolute;
  left: 14px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.walk-btn .material-symbols-outlined { font-size: 18px; }

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
