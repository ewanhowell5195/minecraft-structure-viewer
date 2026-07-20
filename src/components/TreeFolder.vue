<script setup>
import { computed, inject, reactive, ref, watch } from "vue"
import { useContextMenu } from "../composables/useContextMenu.js"
import { useLock } from "../composables/useLock.js"

const props = defineProps({
  node: Object,
  autoOpenName: String,
  expandToken: { type: Number, default: 0 },
  collapseToken: { type: Number, default: 0 }
})

// the owning section provides the tab-specific behaviour: selection source,
// file click/menu, and the folder Load all
const api = inject("treeApi")
const ctx = useContextMenu()
const { locked } = useLock()

const entries = computed(() => {
  const out = []
  for (let [name, child] of props.node.dirs) {
    while (child.dirs.size === 1 && child.files.length === 0) {
      const [k, v] = Array.from(child.dirs)[0]
      name += "/" + k
      child = v
    }
    out.push({ name, child })
  }
  return out
})

// mounted is "ever opened": a natively re-closed folder keeps its children's expansion alive
const opened = ref(new Set())
const mounted = ref(new Set())
const cascade = reactive({})

const addTo = (setRef, name) => { setRef.value = new Set(setRef.value).add(name) }
function dropFrom(setRef, name) {
  const next = new Set(setRef.value)
  next.delete(name)
  setRef.value = next
}

watch(() => props.autoOpenName, n => {
  if (!n) return
  addTo(opened, n)
  addTo(mounted, n)
}, { immediate: true })

function onToggle(name, e) {
  if (e.target.open) {
    addTo(opened, name)
    addTo(mounted, name)
  } else dropFrom(opened, name)
}

// immediate: children mounted later replay the parent's token and keep the cascade going
watch(() => props.expandToken, v => {
  if (!v) return
  const names = entries.value.map(e => e.name)
  opened.value = new Set(Array.from(opened.value).concat(names))
  mounted.value = new Set(Array.from(mounted.value).concat(names))
  for (const n of names) cascade[n] = (cascade[n] ?? 0) + 1
}, { immediate: true })

watch(() => props.collapseToken, v => {
  if (!v) return
  opened.value = new Set()
  mounted.value = new Set()
  for (const k in cascade) delete cascade[k]
})

function expandAll(name) {
  addTo(opened, name)
  addTo(mounted, name)
  cascade[name] = (cascade[name] ?? 0) + 1
}

// unmounting the subtree is what resets every level below to collapsed
function collapseAll(name) {
  dropFrom(opened, name)
  dropFrom(mounted, name)
  delete cascade[name]
}

function collectFiles(node, out = []) {
  out.push(...node.files)
  for (const child of node.dirs.values()) collectFiles(child, out)
  return out
}

function onMenu(name, child, e) {
  const rels = collectFiles(child)
  ctx.open(e, [
    { label: `Load all (${rels.length})`, icon: "stacks", disabled: locked.value || !rels.length, action: () => api.loadAll(rels) },
    { label: "Expand all", icon: "unfold_more", action: () => expandAll(name) },
    { label: "Collapse all", icon: "unfold_less", action: () => collapseAll(name) }
  ])
}

// reveal the page-load selection once; children mount with it already set, so
// their immediate run cascades the whole path open
let revealed = false
watch(() => api.selected(), sel => {
  if (revealed || !sel.length) return
  revealed = true
  const hasSel = node => node.files.some(f => sel.includes(f)) || Array.from(node.dirs.values()).some(hasSel)
  for (const { name, child } of entries.value) if (hasSel(child)) {
    addTo(opened, name)
    addTo(mounted, name)
  }
}, { immediate: true })

const leaf = rel => rel.split("/").at(-1)
</script>

<template>
  <details v-for="{ name, child } in entries" :key="name"
    :open="opened.has(name)" @toggle.stop="onToggle(name, $event)">
    <summary @contextmenu.prevent="onMenu(name, child, $event)">{{ name }}</summary>
    <div class="children" v-if="mounted.has(name)">
      <TreeFolder :node="child" :expand-token="cascade[name] ?? 0" />
    </div>
  </details>
  <div v-for="rel in node.files" :key="rel" class="tree-file"
    :class="{ sel: api.selected().includes(rel), flat: !node.dirs.size }"
    @click="api.open(rel, $event)"
    @contextmenu="api.fileMenu && ($event.preventDefault(), api.fileMenu(rel, $event))">{{ leaf(rel) }}</div>
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

.tree-file.flat { padding-left: 4px; }

.tree-file:hover { color: #fff; background: #ffffff12; }
.tree-file.sel { color: #6fd487; background: #6fd4871f; }
</style>
