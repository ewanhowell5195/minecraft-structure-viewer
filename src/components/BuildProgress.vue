<script setup>
import { computed } from "vue"
import { useBuild } from "../composables/useBuild.js"

// gallery-style hairline progress along the top of the window: blue while
// the block templates build, green while the optimiser runs
const { state } = useBuild()

const pct = computed(() => {
  const p = state.progress
  if (!p || !p.total) return 0
  return Math.min(p.done / p.total * 100, 100)
})
</script>

<template>
  <div v-if="state.progress" :key="state.progress.phase" class="build-progress"
    :class="state.progress.phase" :style="{ width: pct + '%' }"></div>
</template>

<style scoped>
.build-progress {
  position: fixed;
  top: 0;
  left: 0;
  height: 2px;
  z-index: 300;
  pointer-events: none;
  transition: width 0.15s linear;
}

.build-progress.build { background: var(--accent); }
.build-progress.optimise { background: var(--green); }
</style>
