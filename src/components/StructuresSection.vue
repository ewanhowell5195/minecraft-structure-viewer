<script setup>
import { computed, nextTick, ref, watch } from "vue"
import { useStructures } from "../composables/useStructures.js"
import { useStructure } from "../composables/useStructure.js"
import { useContextMenu } from "../composables/useContextMenu.js"
import { useLock } from "../composables/useLock.js"
import TreeFolder from "./TreeFolder.vue"

const structures = useStructures()
const { state, stateMut, computeWorldgen, filteredNames } = structures
const { loadVanilla, loadMany, loadFile } = useStructure()
const ctx = useContextMenu()
const { locked } = useLock()
const fileInput = ref(null)
const treeEl = ref(null)

// page load: once the selection lands (and TreeFolder has expanded the path
// to it), bring the first selected row into view
const stopReveal = watch(() => state.selected.length, async n => {
  if (!n) return
  stopReveal()
  await nextTick()
  treeEl.value?.querySelector(".tree-file.sel")?.scrollIntoView({ block: "center" })
})

const names = computed(() => {
  void state.worldgenReady
  return state.filterMode === "all" ? state.names : filteredNames()
})

// the shown path drops the namespace when only one exists
const soleNs = computed(() => new Set(names.value.map(n => n.slice(0, n.indexOf("/")))).size <= 1)
const disp = rel => soleNs.value ? rel.slice(rel.indexOf("/") + 1) : rel

const FLAT_CAP = 500
const flat = computed(() => {
  const q = state.filterText.trim().toLowerCase()
  if (!q) return null
  return names.value.filter(n => n.toLowerCase().includes(q))
})

const tree = computed(() => {
  const root = { dirs: new Map(), files: [] }
  for (const rel of names.value) {
    const parts = disp(rel).split("/")
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] })
      node = node.dirs.get(parts[i])
    }
    node.files.push(rel)
  }
  return root
})

const autoOpenName = computed(() => soleNs.value ? "" : "minecraft")

// the permanent root row: never collapses, and its context menu works the
// whole list at once (during a search, "load all" takes the matches)
const rootExpand = ref(0), rootCollapse = ref(0)
// searching unmounts the tree; zero the tokens so the remounted tree doesn't
// replay an old "expand all" (its token watcher runs on mount)
watch(() => !!flat.value, isFlat => {
  if (isFlat) {
    rootExpand.value = 0
    rootCollapse.value = 0
  }
})
function onRootMenu(e) {
  const rels = flat.value ?? names.value
  const items = [
    { label: `Load all (${rels.length})`, icon: "stacks", disabled: locked.value || !rels.length, action: () => loadMany(rels) }
  ]
  if (!flat.value) items.push(
    { label: "Expand all", icon: "unfold_more", action: () => rootExpand.value++ },
    { label: "Collapse all", icon: "unfold_less", action: () => rootCollapse.value++ }
  )
  ctx.open(e, items)
}

async function onMode(e) {
  stateMut.filterMode = e.target.value
  if (e.target.value !== "all") await computeWorldgen()
}

function onFile(e) {
  loadFile(e.target.files[0])
  e.target.value = ""
}
</script>

<template>
  <section class="structures">
    <h2>
      Structures
      <span class="count">{{ names.length === state.names.length ? state.names.length : `${names.length}/${state.names.length}` }}</span>
    </h2>
    <div class="controls">
      <input v-model="stateMut.filterText" placeholder="Filter…">
      <select :value="state.filterMode" @change="onMode" :disabled="locked" title="all: every structure. standalone: neither pulled into another build nor loads any other structure blocks. starters: anything that starts a build (never placed as a piece of another).">
        <option value="all">All</option>
        <option value="standalone">Standalone</option>
        <option value="starters">Starters</option>
      </select>
    </div>
    <div class="tree" :class="{ disabled: locked }" ref="treeEl">
      <div v-if="state.indexing" class="empty">Indexing…</div>
      <template v-else>
        <div class="tree-root" title="Right-click for options" @contextmenu.prevent="onRootMenu($event)">All Structures</div>
        <template v-if="flat">
          <div v-if="!flat.length" class="empty">No match</div>
          <div v-for="rel in flat.slice(0, FLAT_CAP)" :key="rel" class="tree-file"
            :class="{ sel: state.selected.includes(rel) }"
            @click="loadVanilla(rel, $event)">{{ disp(rel) }}</div>
          <div v-if="flat.length > FLAT_CAP" class="empty">…and {{ flat.length - FLAT_CAP }} more</div>
        </template>
        <div v-else class="root-children">
          <TreeFolder :node="tree" :auto-open-name="autoOpenName"
            :expand-token="rootExpand" :collapse-token="rootCollapse" />
        </div>
      </template>
    </div>
    <button :disabled="locked" @click="fileInput.click()">
      <span class="material-symbols-outlined">upload_file</span>
      Open Structure File
    </button>
    <input ref="fileInput" type="file" accept=".nbt,.litematic,.schem,.mcstructure" hidden @change="onFile">
  </section>
</template>

<style scoped>
.structures {
  flex: 1;
  min-height: 270px;
}

h2 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.count {
  font-weight: 400;
  letter-spacing: normal;
  text-transform: none;
}

.controls {
  display: flex;
  gap: 6px;
}

.controls input {
  flex: 1;
  min-width: 0;
}

.tree {
  flex: 1;
  min-height: 120px;
  overflow: auto;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  user-select: none;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
}

.tree .empty { color: var(--text-dim); }

.tree.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.tree-root {
  color: var(--text);
  font-weight: 600;
  padding: 1px 0;
  cursor: context-menu;
  user-select: none;
}

.tree-root:hover { color: #fff; }

.root-children { margin-left: 14px; }

.tree-file {
  cursor: pointer;
  color: #8fb3cc;
  padding: 1px 4px;
  border-radius: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-file:hover { color: #fff; background: #ffffff12; }
.tree-file.sel { color: #6fd487; background: #6fd4871f; }

button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

button .material-symbols-outlined { font-size: 18px; }
</style>
