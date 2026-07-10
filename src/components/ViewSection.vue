<script setup>
import { useScene } from "../composables/useScene.js"
import { useBuild, NOON } from "../composables/useBuild.js"
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
      <template v-if="buildState.lighting === 'world'">
        <label for="daytime">Daytime</label>
        <div class="daytime">
          <input id="daytime" type="range" min="0" max="23999" v-model.number="buildState.daytime">
          <span class="value">{{ buildState.daytime }}</span>
          <button class="reset" title="Reset to noon" :disabled="buildState.daytime === NOON" @click="buildState.daytime = NOON">
            <span class="material-symbols-outlined">restart_alt</span>
          </button>
        </div>
      </template>
      <label for="wireframe">Wireframe</label>
      <select id="wireframe" v-model="view.wireframe">
        <option value="off">Off</option>
        <option value="wire">Wireframe</option>
        <option value="overlay">Overlay</option>
      </select>
    </div>
    <div class="checks">
      <label class="check">
        <input type="checkbox" :checked="view.ortho" @change="sceneApi.setOrthoManual($event.target.checked)">
        Orthographic camera
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

.daytime {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.daytime input {
  flex: 1;
  min-width: 0;
}

.daytime .value {
  flex: none;
  min-width: 5ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--text-dim);
}

.daytime .reset {
  flex: none;
  padding: 2px;
}

.daytime .reset:disabled {
  opacity: 0.35;
  cursor: default;
}

.daytime .reset .material-symbols-outlined { font-size: 16px; }
</style>
