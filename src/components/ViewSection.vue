<script setup>
import { ref } from "vue"
import { useScene } from "../composables/useScene.js"
import { useBuild } from "../composables/useBuild.js"

const sceneApi = useScene()
const { view } = sceneApi
const { state: buildState } = useBuild()
const collapsed = ref(false)
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
    </div>
    <div class="checks">
      <label class="check" title="Show barrier, light, and structure void blocks as their icons">
        <input type="checkbox" v-model="buildState.technical">
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
</style>
