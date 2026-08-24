<script setup>
import { computed, nextTick, provide, ref, watch } from "vue"
import { useStructures } from "../composables/useStructures.js"
import { useStructure } from "../composables/useStructure.js"
import { useWorld } from "../composables/useWorld.js"
import { useContextMenu } from "../composables/useContextMenu.js"
import { useLock } from "../composables/useLock.js"
import { useCompare } from "../composables/useCompare.js"
import { useCompareDiff } from "../composables/useCompareDiff.js"
import { leafName } from "../transforms.js"
import { tab, isDiffTab } from "../composables/useTab.js"
import TreeFolder from "./TreeFolder.vue"
import ListTabs from "./ListTabs.vue"

const structures = useStructures()
const { state, stateMut, computeWorldgen, computeAdvIndex, advVocab, filteredNames } = structures
const { state: structState, loadVanilla, loadMany, loadFile, closeFile } = useStructure()
const ctx = useContextMenu()
const { locked } = useLock()
const compare = useCompare()
const diff = useCompareDiff()
const fileInput = ref(null)
const treeEl = ref(null)
const collapsed = ref(false)

// a plain click opens from both versions; modified clicks keep the combine
// behaviour, unless only the compared version has the structure
function openRel(rel, ev) {
  const mod = ev?.shiftKey || ev?.ctrlKey || ev?.metaKey
  if (compare.versionArmed() && (!mod || !structures.has(rel))) return compare.openVersion(rel)
  return loadVanilla(rel, ev)
}

// the New list's rels exist only in the comparison jar, so bulk loads skip them
const loadable = rels => rels.filter(rel => structures.has(rel))

provide("treeApi", {
  selected: () => state.selected,
  open: openRel,
  loadable,
  loadAll: rels => loadMany(loadable(rels)),
  fileMenu: onFileMenu
})

// comparing needs exactly one loaded structure, and the panel owns comparison
function onFileMenu(rel, e) {
  const sel = state.selected
  if (locked.value || compare.versionArmed() || sel.length !== 1 || sel[0] === rel) return
  ctx.open(e, [{
    label: `Compare with ${leafName(sel[0])}`,
    icon: "compare",
    action: () => compare.enter(rel)
  }])
}

const stopReveal = watch(() => state.selected.length, async n => {
  if (!n) return
  stopReveal()
  await nextTick()
  treeEl.value?.querySelector(".tree-file.sel")?.scrollIntoView({ block: "center" })
})

const ADV_MODES = new Set(["block", "item", "entity"])
const advMode = computed(() => ADV_MODES.has(state.filterMode))
const advPlaceholder = computed(() => ({
  block: "Blocks, e.g. chest, diamond block…",
  item: "Items, e.g. diamond, emerald…",
  entity: "Entities, e.g. villager, cat…"
})[state.filterMode])
const advIndexing = computed(() => advMode.value && !state.advReady)
const vocab = computed(() => (void state.advReady, advMode.value ? advVocab() : []))

const diffTab = computed(() => isDiffTab(tab.value) ? tab.value : "")

const names = computed(() => {
  void state.worldgenReady
  void state.advReady
  if (diffTab.value) return (void diff.state.rev, diff.list(diffTab.value))
  return state.filterMode === "all" ? state.names : filteredNames()
})

const sweeping = computed(() => compare.versionArmed() && (void diff.state.rev, !diff.state.ready))
const noDiff = computed(() => compare.versionArmed() && (void diff.state.rev, diff.nothingDiffers()))
const sweepPct = computed(() => (void diff.state.rev, diff.state.progress * 100))

// comparing counts disagreements, so the heading sums the tabs
const countLabel = computed(() => {
  const total = state.names.length
  if (compare.versionArmed()) return (void diff.state.rev, Object.values(diff.state.counts).reduce((a, b) => a + b, 0))
  return names.value.length === total ? total : `${names.value.length}/${total}`
})

const ROOTS = { new: "New Structures", changed: "Changed Structures", removed: "Removed Structures" }
const rootLabel = computed(() => ROOTS[diffTab.value] ?? "All Structures")

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

const rootExpand = ref(0), rootCollapse = ref(0)
// zero the tokens while searching: the tree's token watcher runs on mount, so
// a remounted tree would replay a stale "expand all"
watch(() => !!flat.value, isFlat => {
  if (isFlat) {
    rootExpand.value = 0
    rootCollapse.value = 0
  }
})
function onRootMenu(e) {
  const rels = loadable(flat.value ?? names.value)
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
  const mode = e.target.value
  stateMut.filterMode = mode
  if (mode === "starters" || mode === "standalone") await computeWorldgen()
  else if (ADV_MODES.has(mode)) await computeAdvIndex()
}

function onFile(e) {
  const file = e.target.files[0]
  e.target.value = ""
  if (!file) return
  if (/\.(zip|mca)$/i.test(file.name)) useWorld().openWorld(file)
  else if (compare.versionArmed()) compare.setMainFile(file)
  else loadFile(file)
}

// comparing owns its copy of the file; a pre-arm file closes the ordinary way
const openFile = computed(() => compare.versionArmed() && compare.fileName("main") ? compare.fileName("main") : structState.file)
const closeOpenFile = () => compare.versionArmed() && compare.fileName("main") ? compare.clearFile("main") : closeFile()
</script>

<template>
  <section class="structures" :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      Structures
      <span class="count">{{ countLabel }}</span>
    </h2>
    <div class="controls">
      <input v-model="stateMut.filterText" placeholder="Filter…">
      <select :value="state.filterMode" @change="onMode" :disabled="locked || state.indexing || !!diffTab" title="all: every structure. starters: anything that starts a build (never placed as a piece of another). standalone: neither pulled into another build nor loads any other structure blocks. has block / item / entity: structures containing a matching block, a matching item in a container or its loot table, or a matching entity (placed or spawner-spawned).">
        <option value="all">All</option>
        <option value="starters">Starters</option>
        <option value="standalone">Standalone</option>
        <option value="block">Has block…</option>
        <option value="item">Has item…</option>
        <option value="entity">Has entity…</option>
      </select>
    </div>
    <div v-if="advMode" class="controls">
      <input v-model="stateMut.advQuery" :disabled="locked" list="adv-vocab"
        :placeholder="advPlaceholder">
      <datalist id="adv-vocab">
        <option v-for="v in vocab" :key="v" :value="v" />
      </datalist>
    </div>
    <ListTabs />
    <div class="tree" :class="{ disabled: locked, notabs: sweeping || noDiff }" ref="treeEl">
      <div v-if="state.indexing || advIndexing" class="empty">Indexing…</div>
      <div v-else-if="sweeping" class="empty">
        Comparing…
        <div class="loadbar"><div class="fill" :style="{ width: sweepPct + '%' }"></div></div>
      </div>
      <div v-else-if="noDiff" class="empty">No structures differ between the two versions</div>
      <template v-else>
        <div class="tree-root" title="Right-click for options" @contextmenu.prevent="onRootMenu($event)">{{ rootLabel }}</div>
        <template v-if="flat">
          <div v-if="!flat.length" class="empty">No match</div>
          <div v-for="rel in flat.slice(0, FLAT_CAP)" :key="rel" class="tree-file"
            :class="{ sel: state.selected.includes(rel) }"
            @click="openRel(rel, $event)"
            @contextmenu.prevent="onFileMenu(rel, $event)">{{ disp(rel) }}</div>
          <div v-if="flat.length > FLAT_CAP" class="empty">…and {{ flat.length - FLAT_CAP }} more</div>
        </template>
        <div v-else-if="!names.length" class="empty">None</div>
        <div v-else class="root-children">
          <TreeFolder :node="tree" :auto-open-name="autoOpenName"
            :expand-token="rootExpand" :collapse-token="rootCollapse" />
        </div>
      </template>
    </div>
    <button v-if="openFile" :disabled="locked" :title="openFile" @click="closeOpenFile">
      <span class="material-symbols-outlined">close</span>
      Close Structure File
    </button>
    <button v-else :disabled="locked" @click="fileInput.click()">
      <span class="material-symbols-outlined">upload_file</span>
      Open Structure File
    </button>
    <input ref="fileInput" type="file" accept=".nbt,.litematic,.schem,.mcstructure,.zip,.mca" hidden @change="onFile">
  </section>
</template>

<style scoped>
.structures {
  flex: 1;
  min-height: 270px;
}

.structures.collapsed {
  flex: none;
  min-height: 0;
}

.count {
  margin-left: auto;
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
  border-radius: 0 0 6px 6px;
  padding: 6px 8px;
}

.tree .empty { color: var(--text-dim); }

.tree .empty .loadbar { margin-top: 6px; }

/* with the tab strip gone there is nothing above the tree to sit flush against */
.tree.notabs { border-radius: 6px; }

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

.tree-root:hover, .tree-root.ctx-target { color: #fff; }

.root-children { margin-left: 14px; }


button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

button .material-symbols-outlined { font-size: 18px; }
</style>
