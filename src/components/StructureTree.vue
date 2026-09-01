<script setup>
import { computed, inject, ref, watch } from "vue"
import { useContextMenu } from "../composables/useContextMenu.js"
import { useLock } from "../composables/useLock.js"
import TreeFolder from "./TreeFolder.vue"

const props = defineProps({
  rels: { type: Array, required: true },
  label: { type: Function, required: true },
  rootLabel: { type: String, required: true },
  autoOpenName: { type: String, default: "" },
  flat: { type: Array, default: null },
  flatCap: { type: Number, default: Infinity },
  loadable: { type: Function, default: rels => rels }
})

const api = inject("treeApi")
const ctx = useContextMenu()
const { locked } = useLock()

const tree = computed(() => {
  const root = { dirs: new Map(), files: [] }
  for (const rel of props.rels) {
    const parts = props.label(rel).split("/")
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] })
      node = node.dirs.get(parts[i])
    }
    node.files.push(rel)
  }
  return root
})

const rootExpand = ref(0), rootCollapse = ref(0)
// zero the tokens while searching: the tree's token watcher runs on mount, so
// a remounted tree would replay a stale "expand all"
watch(() => !!props.flat, isFlat => {
  if (isFlat) {
    rootExpand.value = 0
    rootCollapse.value = 0
  }
})

function onRootMenu(e) {
  const rels = props.loadable(props.flat ?? props.rels)
  const items = [
    { label: `Load all (${rels.length})`, icon: "stacks", disabled: locked.value || !rels.length, action: () => api.loadAll(rels) }
  ]
  if (!props.flat) items.push(
    { label: "Expand all", icon: "unfold_more", action: () => rootExpand.value++ },
    { label: "Collapse all", icon: "unfold_less", action: () => rootCollapse.value++ }
  )
  ctx.open(e, items)
}
</script>

<template>
  <div class="tree-root" title="Right-click for options" @contextmenu.prevent="onRootMenu($event)">{{ rootLabel }}</div>
  <template v-if="flat">
    <div v-if="!flat.length" class="empty">No match</div>
    <div v-for="rel in flat.slice(0, flatCap)" :key="rel" class="tree-file"
      :class="{ sel: api.selected().includes(rel) }"
      @click="api.open(rel, $event)"
      @contextmenu="api.fileMenu && ($event.preventDefault(), api.fileMenu(rel, $event))">{{ label(rel) }}</div>
    <div v-if="flat.length > flatCap" class="empty">…and {{ flat.length - flatCap }} more</div>
  </template>
  <div v-else-if="!rels.length" class="empty">None</div>
  <div v-else class="root-children">
    <TreeFolder :node="tree" :auto-open-name="autoOpenName"
      :expand-token="rootExpand" :collapse-token="rootCollapse" />
  </div>
</template>

<style scoped>
.tree-root {
  color: var(--text);
  font-weight: 600;
  padding: 1px 0;
  cursor: context-menu;
  user-select: none;
}

.tree-root:hover, .tree-root.ctx-target { color: #fff; }

.root-children { margin-left: 14px; }

.empty { color: var(--text-dim); }
</style>
