<script setup>
import { ref } from "vue"
import { useScene } from "../composables/useScene.js"
import { useBuild, NOON } from "../composables/useBuild.js"
import { useLock } from "../composables/useLock.js"

const sceneApi = useScene()
const { view } = sceneApi
const { state: buildState } = useBuild()
const { locked } = useLock()
const collapsed = ref(true)
</script>

<template>
  <section :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      View
    </h2>
    <div class="fields">
      <label for="wireframe">Wireframe</label>
      <select id="wireframe" v-model="view.wireframe">
        <option value="off">Off</option>
        <option value="overlay">Overlay</option>
        <option value="wire">Wireframe</option>
      </select>
      <label for="lighting">Lighting</label>
      <select id="lighting" v-model="buildState.lighting" :disabled="locked">
        <option value="world">World</option>
        <option value="off">Off</option>
      </select>
    </div>
    <div class="checks">
      <template v-if="buildState.lighting === 'world'">
        <label class="check">
          <input type="checkbox" v-model="buildState.fullbright" :disabled="locked">
          Fullbright
        </label>
        <label v-if="!buildState.fullbright && buildState.dimension === 'overworld'" class="check daytime">
          Daytime
          <input type="range" min="0" max="23999" v-model.number="buildState.daytime">
          <span class="value">{{ buildState.daytime }}</span>
          <button class="reset" title="Reset to noon" :disabled="buildState.daytime === NOON" @click.prevent="buildState.daytime = NOON">
            <span class="material-symbols-outlined">restart_alt</span>
          </button>
        </label>
      </template>
      <label class="check" title="Show barrier, light, and structure void blocks as their icons">
        <input type="checkbox" v-model="buildState.technical" :disabled="locked">
        Technical blocks
      </label>
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

button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

button .material-symbols-outlined { font-size: 18px; }

.daytime { min-width: 0; }

.daytime input[type="range"] {
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
