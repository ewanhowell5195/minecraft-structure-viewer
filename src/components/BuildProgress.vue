<script setup>
import { computed } from "vue"
import { useBuild } from "../composables/useBuild.js"
import { useStructure } from "../composables/useStructure.js"

// gallery-style hairline progress along the top of the window: amber while
// structure files read in, gold while the light volume floods, blue while
// the block templates build, green while the optimiser runs
const { state } = useBuild()
const { state: current } = useStructure()

const prog = computed(() =>
  current.reading ? { phase: "read", ...current.reading } : state.progress)

const pct = computed(() => {
  const p = prog.value
  if (!p || !p.total) return 0
  return Math.min(p.done / p.total * 100, 100)
})
</script>

<template>
  <div v-if="prog" :key="prog.phase" class="build-progress"
    :class="prog.phase" :style="{ width: pct + '%' }"></div>
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

.build-progress.read { background: #d9a13f; }
.build-progress.light { background: #e8d44d; }
.build-progress.build { background: var(--accent); }
.build-progress.optimise { background: var(--green); }
</style>
