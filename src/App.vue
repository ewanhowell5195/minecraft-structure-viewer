<script setup>
import { onMounted, ref } from "vue"
import { loadLibrary } from "./lib.js"
import { usePacks } from "./composables/usePacks.js"
import PacksSection from "./components/PacksSection.vue"

const libError = ref("")
const { loadBase } = usePacks()

onMounted(async () => {
  try {
    await loadLibrary()
  } catch (err) {
    libError.value = String(err)
    return
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
      </template>
    </aside>
    <main class="viewport">
      <canvas id="view"></canvas>
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
</style>
