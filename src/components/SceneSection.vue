<script setup>
import { useBuild } from "../composables/useBuild.js"
import { useStructure } from "../composables/useStructure.js"
import { useLock } from "../composables/useLock.js"

const { state: buildState, clearCollected, exportCurrent } = useBuild()
const { state: structureState } = useStructure()
const { locked } = useLock()

function onExport(ev) {
  const v = ev.target.value
  ev.target.value = ""
  if (v) exportCurrent(v, structureState.name)
}
</script>

<template>
  <section>
    <h2>Scene</h2>
    <div class="fields">
      <label for="export">Export</label>
      <select id="export" :disabled="locked || !buildState.info" @change="onExport">
        <option value="" selected>Save as…</option>
        <option value="glb">.glb</option>
        <option value="obj">.obj</option>
      </select>
    </div>
    <label class="check">
      <input type="checkbox" v-model="buildState.collect" :disabled="locked">
      Collect structures
    </label>
    <button v-if="buildState.placedCount" :disabled="locked" @click="clearCollected()">
      <span class="material-symbols-outlined">delete_sweep</span>
      Clear Collected
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
