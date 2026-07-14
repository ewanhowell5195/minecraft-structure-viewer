<script setup>
import { computed, ref } from "vue"
import { useFeatures } from "../composables/useFeatures.js"
import { useStructure } from "../composables/useStructure.js"
import { useContextMenu } from "../composables/useContextMenu.js"
import { useLock } from "../composables/useLock.js"
import ListTabs from "./ListTabs.vue"

const features = useFeatures()
const { state, stateMut } = features
const { clickFeature, loadFeatures, loadFeatureField } = useStructure()
const ctx = useContextMenu()
const { locked } = useLock()
const collapsed = ref(false)

const soleNs = computed(() => new Set(state.names.map(n => n.slice(0, n.indexOf("/")))).size <= 1)
const disp = rel => soleNs.value ? rel.slice(rel.indexOf("/") + 1) : rel

const shown = computed(() => (state.filterText, state.names.length, features.visibleNames()))

function onRootMenu(e) {
  const rels = shown.value
  ctx.open(e, [
    { label: `Load all (${rels.length})`, icon: "stacks", disabled: locked.value || !rels.length, action: () => loadFeatures(rels) }
  ])
}

function onRowMenu(rel, e) {
  ctx.open(e, [
    { label: "Generate field", icon: "grid_view", disabled: locked.value || features.isStatic(rel), action: () => loadFeatureField(rel) }
  ])
}

</script>

<template>
  <section class="features" :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      Features
      <span class="count">{{ shown.length === state.names.length ? state.names.length : `${shown.length}/${state.names.length}` }}</span>
    </h2>
    <div class="controls">
      <input v-model="stateMut.filterText" placeholder="Filter…">
    </div>
    <ListTabs />
    <div class="tree" :class="{ disabled: locked }">
      <div v-if="state.indexing" class="empty">Indexing…</div>
      <template v-else>
        <div class="tree-root" title="Right-click for options" @contextmenu.prevent="onRootMenu($event)">All Features</div>
        <div v-if="!shown.length" class="empty">{{ state.names.length ? "No match" : "No features" }}</div>
        <div v-else class="root-children">
          <div v-for="rel in shown" :key="rel" class="tree-file"
            :class="{ sel: state.selected.includes(rel) }"
            @click="clickFeature(rel, $event)"
            @contextmenu.prevent="onRowMenu(rel, $event)">{{ disp(rel) }}</div>
        </div>
      </template>
    </div>
    <p class="hint">Generated from the game's worldgen data; loads show a representative roll, Re-roll picks a fresh seed</p>
  </section>
</template>

<style scoped>
.features {
  flex: 1;
  min-height: 270px;
}

.features.collapsed {
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

.tree-root {
  color: var(--text);
  font-weight: 600;
  padding: 1px 0;
  cursor: context-menu;
  user-select: none;
}

.tree-root:hover { color: #fff; }

.root-children { margin-left: 14px; }

.tree.disabled {
  opacity: 0.5;
  pointer-events: none;
}

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

.hint {
  margin: 0;
  color: var(--text-dim);
  font-size: 11px;
}
</style>
