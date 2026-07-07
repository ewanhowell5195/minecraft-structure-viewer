<script setup>
import { computed, onMounted, ref, watch } from "vue"
import { loadLibrary } from "./lib.js"
import { usePacks } from "./composables/usePacks.js"
import { useStructures } from "./composables/useStructures.js"
import { useStructure } from "./composables/useStructure.js"
import { useBuild } from "./composables/useBuild.js"
import { useScene } from "./composables/useScene.js"
import PacksSection from "./components/PacksSection.vue"
import StructuresSection from "./components/StructuresSection.vue"
import ViewSection from "./components/ViewSection.vue"
import LevelMenu from "./components/LevelMenu.vue"
import WalkOverlay from "./components/WalkOverlay.vue"

const libError = ref("")
const canvasEl = ref(null)
const { loadBase } = usePacks()
const structures = useStructures()
const { state: current, structure, loadVanilla } = useStructure()
const { state: buildState } = useBuild()
const sceneApi = useScene()

const fmtK = n => n >= 1000 ? +(n / 1000).toFixed(1) + "K" : String(Math.round(n))

const info = computed(() => {
  const i = buildState.info
  if (!i) return ""
  const name = current.name ? `${current.name} · ` : ""
  return `${name}${i.size} · ${i.blocks} blocks · ${i.palette} palette entries · `
    + `draws ${fmtK(i.rawDc)} → ${i.optDc} · tris ${fmtK(i.rawTris)} → ${fmtK(i.optTris)}`
})

onMounted(async () => {
  try {
    await loadLibrary()
  } catch (err) {
    libError.value = String(err)
    return
  }
  sceneApi.init(canvasEl.value)
  const vanilla = new URLSearchParams(location.search).get("vanilla")
  if (vanilla) {
    const stop = watch(() => structures.state.names.length, n => {
      if (!n) return
      stop()
      if (structures.has(vanilla)) loadVanilla(vanilla)
    })
  }
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
      </template>
    </aside>
    <main class="viewport">
      <canvas id="view" ref="canvasEl"></canvas>
      <div v-if="current.error" class="chip error">{{ current.error }}</div>
      <div v-else-if="buildState.status" class="chip">{{ buildState.status }}</div>
      <div v-else-if="info" class="chip">{{ info }}</div>
      <LevelMenu />
      <WalkOverlay />
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
}

.app-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
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
  top: 10px;
  left: 10px;
  background: #000000a0;
  color: var(--text-dim);
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12px;
  pointer-events: none;
}

.chip.error { color: var(--red); }
</style>
