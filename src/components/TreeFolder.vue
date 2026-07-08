<script setup>
import { computed, reactive, ref, watch } from "vue"
import { useStructure } from "../composables/useStructure.js"
import { useStructures } from "../composables/useStructures.js"
import { useContextMenu } from "../composables/useContextMenu.js"
import { useLock } from "../composables/useLock.js"

const props = defineProps({
  node: Object,
  autoOpenName: String,
  expandToken: { type: Number, default: 0 },  // parent's "expand everything" signal, counts up
  collapseToken: { type: Number, default: 0 } // parent's "collapse everything" signal, counts up
})

const { state } = useStructures()
const { loadVanilla, loadMany } = useStructure()
const ctx = useContextMenu()
const { locked } = useLock()

// chains of single-child folders compact into one "a/b/c" row
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

// opened mirrors the details' actual state; mounted is "ever opened", so a
// natively re-closed folder keeps its children (and their expansion) alive
const opened = ref(new Set())
const mounted = ref(new Set())
// per-child expand-everything tokens (cascades the command down the tree)
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

// a parent said "expand everything": open every folder here and pass it on
watch(() => props.expandToken, v => {
  if (!v) return
  const names = entries.value.map(e => e.name)
  opened.value = new Set(Array.from(opened.value).concat(names))
  mounted.value = new Set(Array.from(mounted.value).concat(names))
  for (const n of names) cascade[n] = (cascade[n] ?? 0) + 1
}, { immediate: true })

// "collapse everything": closing + unmounting here resets all levels below
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

// dropping from mounted unmounts the subtree, so every level below starts
// collapsed again next time it opens
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
    { label: `Load all (${rels.length})`, icon: "stacks", disabled: locked.value || !rels.length, action: () => loadMany(rels) },
    { label: "Expand all", icon: "unfold_more", action: () => expandAll(name) },
    { label: "Collapse all", icon: "unfold_less", action: () => collapseAll(name) }
  ])
}

// reveal the page-load selection: folders containing a selected structure
// expand once, then behave normally. children mount with the selection
// already set, so their immediate run cascades the whole path open
let revealed = false
watch(() => state.selected, sel => {
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
