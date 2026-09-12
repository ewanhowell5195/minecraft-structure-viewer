<script setup>
import { computed, ref } from "vue"
import { useScene } from "../composables/useScene.js"
import { useBuild } from "../composables/useBuild.js"
import { useProcessors } from "../composables/useProcessors.js"
import { useStructures } from "../composables/useStructures.js"
import { useLock } from "../composables/useLock.js"

const sceneApi = useScene()
const { view } = sceneApi
const { state: buildState } = useBuild()
const procs = useProcessors()
const structures = useStructures()
const { locked } = useLock()
const collapsed = ref(false)

// only worth offering where something on screen actually has processors
const hasProcessors = computed(() => procs.state.session
  || structures.state.selected.some(rel => !!structures.processorEntry(rel)))
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
        <option value="outline">Outline</option>
      </select>
    </div>
    <div class="checks">
      <label class="check" title="Show barrier and light blocks as their icons">
        <input type="checkbox" v-model="buildState.technical">
        Technical blocks
      </label>
      <label class="check" title="Fill the gaps in a saved structure's bounding box, which are its structure voids">
        <input type="checkbox" v-model="buildState.structureVoids">
        Structure voids
      </label>
      <label class="check">
        <input type="checkbox" :checked="view.ortho" @change="sceneApi.setOrthoManual($event.target.checked)">
        Orthographic camera
      </label>
      <label class="check">
        <input type="checkbox" v-model="view.grid">
        Grid
      </label>
      <div v-if="hasProcessors" class="row">
        <label class="check" title="The block rewrites the game applies when it places a structure: mossify, rot, and the cobwebs in abandoned villages">
          <input type="checkbox" :checked="procs.state.on" :disabled="locked"
            @change="procs.setOn($event.target.checked)">
          Processors
        </label>
        <button class="icon" :disabled="!procs.state.on || locked"
          title="Shuffle the processor roll" @click="procs.shuffle()">
          <span class="material-symbols-outlined">shuffle</span>
        </button>
      </div>
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

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row .check { flex: 1; }

button.icon {
  padding: 0;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  background: none;
  border: none;
  color: var(--text-dim);
}

button.icon:hover:not(:disabled) {
  background: #ffffff14;
  color: var(--text);
}
</style>
