<script setup>
import { computed, onMounted, onBeforeUnmount } from "vue"
import { useFind } from "../composables/useFind.js"

const { state, go, stop } = useFind()

const STEPS = [1, 10, 100]
const steps = computed(() => STEPS.filter(n => state.total > n))
const num = n => n.toLocaleString("en")

function onKey(e) {
  if (e.key === "Escape" && state.on) stop()
}

onMounted(() => addEventListener("keydown", onKey))
onBeforeUnmount(() => removeEventListener("keydown", onKey))
</script>

<template>
  <div v-if="state.on" class="find-bar">
    <button v-for="n in Array.from(steps).reverse()" :key="'p' + n" class="step" :title="`Back ${n}`" @click="go(-n)">
      <span v-for="i in STEPS.indexOf(n) + 1" :key="i" class="material-symbols-outlined">chevron_left</span>
    </button>
    <div class="pos">
      <span class="n">{{ num(state.index + 1) }}/{{ num(state.total) }}</span>
      <span v-if="state.label" class="nm" :title="state.label">{{ state.label }}</span>
    </div>
    <button v-for="n in steps" :key="'n' + n" class="step" :title="`Forward ${n}`" @click="go(n)">
      <span v-for="i in STEPS.indexOf(n) + 1" :key="i" class="material-symbols-outlined">chevron_right</span>
    </button>
    <button class="quit" title="Stop finding" @click="stop">
      <span class="material-symbols-outlined">close</span>
    </button>
  </div>
</template>

<style scoped>
.find-bar {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: min(560px, calc(100% - 28px));
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.pos {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 0 6px;
}

.n {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  white-space: nowrap;
}

.nm {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

button {
  display: flex;
  align-items: center;
  padding: 4px 6px;
  background: none;
  border: none;
  color: var(--text-dim);
}

button:hover:not(:disabled) {
  background: #ffffff14;
  color: var(--text);
}

.step .material-symbols-outlined { font-size: 18px; }
.step .material-symbols-outlined + .material-symbols-outlined { margin-left: -11px; }
.quit .material-symbols-outlined { font-size: 17px; }
</style>
