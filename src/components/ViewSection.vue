<script setup>
import { useScene } from "../composables/useScene.js"
import { useBuild } from "../composables/useBuild.js"
import { useLock } from "../composables/useLock.js"

const sceneApi = useScene()
const { view } = sceneApi
const { state: buildState } = useBuild()
const { locked } = useLock()
</script>

<template>
  <section>
    <h2>View</h2>
    <div class="fields">
      <label for="lighting">Lighting</label>
      <select id="lighting" v-model="buildState.lighting" :disabled="locked">
        <option value="world">World</option>
        <option value="off">Off</option>
      </select>
    </div>
    <div class="checks">
      <label class="check">
        <input type="checkbox" :checked="view.ortho" @change="sceneApi.setOrthoManual($event.target.checked)">
        Orthographic camera
      </label>
      <label class="check">
        <input type="checkbox" v-model="view.wireframe">
        Wireframe
      </label>
      <label class="check">
        <input type="checkbox" v-model="view.grid">
        Grid
      </label>
    </div>
    <button @click="sceneApi.fit()">
      <span class="material-symbols-outlined">recenter</span>
      Fit View
    </button>
  </section>
</template>

<style scoped>
.fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px;
  align-items: center;
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0;
}

.checks:first-child { margin-top: 0; }
.checks:last-child { margin-bottom: 0; }

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text);
  user-select: none;
}

button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

button .material-symbols-outlined { font-size: 18px; }
</style>
