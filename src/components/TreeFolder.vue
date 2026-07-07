<script setup>
import { computed, ref, watch } from "vue"
import { useStructure } from "../composables/useStructure.js"
import { useStructures } from "../composables/useStructures.js"

const props = defineProps({
  node: Object,
  autoOpenName: String
})

const { state } = useStructures()
const { loadVanilla } = useStructure()

// chains of single-child folders compact into one "a/b/c" row
const entries = computed(() => {
  const out = []
  for (let [name, child] of props.node.dirs) {
    while (child.dirs.size === 1 && child.files.length === 0) {
      const [k, v] = [...child.dirs][0]
      name += "/" + k
      child = v
    }
    out.push({ name, child })
  }
  return out
})

const opened = ref(new Set())
function onToggle(name, e) {
  if (e.target.open) opened.value = new Set(opened.value).add(name)
}

// reveal the page-load selection: folders containing a selected structure
// expand once, then behave normally. children mount with the selection
// already set, so their immediate run cascades the whole path open
let revealed = false
watch(() => state.selected, sel => {
  if (revealed || !sel.length) return
  revealed = true
  const hasSel = node => node.files.some(f => sel.includes(f)) || [...node.dirs.values()].some(hasSel)
  const add = new Set(opened.value)
  for (const { name, child } of entries.value) if (hasSel(child)) add.add(name)
  opened.value = add
}, { immediate: true })

const leaf = rel => rel.split("/").at(-1)
</script>

<template>
  <details v-for="{ name, child } in entries" :key="name"
    :open="name === autoOpenName || opened.has(name)" @toggle.stop="onToggle(name, $event)">
    <summary>{{ name }}</summary>
    <div class="children" v-if="opened.has(name) || name === autoOpenName">
      <TreeFolder :node="child" />
    </div>
  </details>
  <div v-for="rel in node.files" :key="rel" class="tree-file"
    :class="{ sel: state.selected.includes(rel) }"
    @click="loadVanilla(rel, $event)">{{ leaf(rel) }}</div>
</template>

<style scoped>
summary {
  cursor: pointer;
  color: var(--text);
  padding: 1px 0;
}

summary:hover { color: #fff; }

.children { margin-left: 14px; }

.tree-file {
  cursor: pointer;
  color: #8fb3cc;
  padding: 1px 4px 1px 16px;
  border-radius: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-file:hover { color: #fff; background: #ffffff12; }
.tree-file.sel { color: #6fd487; background: #6fd4871f; }
</style>
