<script setup>
import { computed, watch } from "vue"
import { tab } from "../composables/useTab.js"
import { useCompareDiff } from "../composables/useCompareDiff.js"

// identical assets both sides: features would render the same twice, so the tab goes
const diff = useCompareDiff()
const noFeatures = computed(() => (void diff.state.rev, diff.active()))
watch(noFeatures, on => { if (on && tab.value === "features") tab.value = "structures" })
</script>

<template>
  <nav class="tabs">
    <button :class="{ active: tab === 'structures' }" @click="tab = 'structures'">Structures</button>
    <button v-if="!noFeatures" :class="{ active: tab === 'features' }" @click="tab = 'features'">Features</button>
  </nav>
</template>

<style scoped>
/* the negative margin cancels the section gap so the buttons sit flush on the tree border */
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: -8px;
}

.tabs button {
  flex: 1;
  padding: 5px 0;
  font-size: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px 6px 0 0;
  border-bottom: none;
  color: var(--text-dim);
  cursor: pointer;
}

.tabs button.active {
  color: var(--text);
  background: #ffffff10;
}
</style>
