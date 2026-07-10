<script setup>
import { ref } from "vue"
import { useSlicers } from "../composables/useSlicers.js"
import { useLock } from "../composables/useLock.js"

const { state } = useSlicers()
const { locked } = useLock()
const collapsed = ref(true)
const AXES = ["x", "y", "z"]
</script>

<template>
  <section :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      Slicers
    </h2>
    <div v-for="a in AXES" :key="a" class="slicer">
      <label class="check">
        <input type="checkbox" v-model="state[a].on" :disabled="locked">
        {{ a.toUpperCase() }} axis
      </label>
      <span class="pos">{{ state[a].on ? state[a].i : "" }}</span>
      <button class="icon" :disabled="!state[a].on || locked" title="Flip which side is sliced"
        @click="state[a].flip = !state[a].flip">
        <span class="material-symbols-outlined">{{ a === "y" ? "swap_vert" : "swap_horiz" }}</span>
      </button>
    </div>
    <div class="hint">Drag a plane's corner handles to move it</div>
  </section>
</template>

<style scoped>
.slicer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text);
  user-select: none;
  flex: 1;
}

.pos {
  min-width: 3ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--text-dim);
}

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

button.icon .material-symbols-outlined { font-size: 18px; }

.hint {
  font-size: 11px;
  color: var(--text-dim);
}
</style>
