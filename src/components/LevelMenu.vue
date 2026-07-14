<script setup>
import { computed, ref } from "vue"
import { useSession } from "../composables/useSession.js"
import { useBuild } from "../composables/useBuild.js"
import { useLock } from "../composables/useLock.js"
import { useFeatures } from "../composables/useFeatures.js"
import { useStructure } from "../composables/useStructure.js"
import { useStructures } from "../composables/useStructures.js"
import { rand32 } from "../transforms.js"

const session = useSession()
const s = session.state
const { state: buildState } = useBuild()
const { locked } = useLock()
const features = useFeatures()
const structures = useStructures()
const { loadFeature, loadFeatures, loadFeatureField, state: structState } = useStructure()
const open = ref(false)

function rerollFeature() {
  const sel = features.state.selected
  if (sel.length > 1) loadFeatures(Array.from(sel), true)
  else if (sel[0]) loadFeature(sel[0], rand32())
}

function fieldFeature() {
  const rel = features.state.selected[0]
  if (rel) loadFeatureField(rel, structState.field ? rand32() : undefined)
}

function singleFeature() {
  const f = structState.field
  if (f) loadFeature(f.rel, f.base)
}

const mode = computed(() => {
  if (s.active) return "session"
  const sel = features.state.selected
  if (sel.length && !structures.state.selected.length && !(sel.length === 1 && features.isStatic(sel[0]))) return "feature"
  if (buildState.hasStructureBlocks) return "toggle"
  return null
})

const headLabel = computed(() => mode.value === "feature"
  ? structState.name.replace(/^minecraft\//, "")
  : s.steps && s.level > 0 ? `${s.label} · Level ${s.level + 1}` : s.label)
</script>

<template>
  <div v-if="mode === 'toggle'" class="level-menu" :class="{ locked }">
    <button :disabled="locked" @click="buildState.hideStructureBlocks = !buildState.hideStructureBlocks">
      <span class="material-symbols-outlined">{{ buildState.hideStructureBlocks ? "visibility" : "visibility_off" }}</span>
      {{ buildState.hideStructureBlocks ? "Show Structure Blocks" : "Hide Structure Blocks" }}
    </button>
  </div>
  <div v-else-if="mode" class="level-menu" :class="{ locked }">
    <!-- collapsed uses visibility so the panel keeps its width and the head button stretches to match -->
    <div class="panel" :class="{ collapsed: !open }">
      <template v-if="mode === 'feature'">
        <button v-if="structState.field" :disabled="locked" @click="singleFeature">
          <span class="material-symbols-outlined">crop_square</span>
          Single
        </button>
        <button v-if="features.state.selected.length === 1" :disabled="locked" @click="fieldFeature">
          <span class="material-symbols-outlined">{{ structState.field ? "shuffle" : "grid_view" }}</span>
          {{ structState.field ? "Re-roll" : "Field" }}
        </button>
        <button v-if="!structState.field" :disabled="locked" @click="rerollFeature">
          <span class="material-symbols-outlined">shuffle</span>
          Re-roll
        </button>
      </template>
      <template v-else-if="s.steps">
        <button v-if="s.level < s.maxDepth" :disabled="locked" @click="session.next()">
          <span class="material-symbols-outlined">skip_next</span>
          Load Next Level
        </button>
        <button v-if="s.level < s.maxDepth" :disabled="locked" @click="session.all()">
          <span class="material-symbols-outlined">fast_forward</span>
          Load All Levels
        </button>
        <button v-if="s.level > 0" :disabled="locked" @click="session.undo()">
          <span class="material-symbols-outlined">undo</span>
          Undo Level
        </button>
        <button v-if="s.kind === 'jigsaw' && s.level > 0" :disabled="locked" @click="session.reloadAll()">
          <span class="material-symbols-outlined">refresh</span>
          Reload
        </button>
        <!-- at max depth a jigsaw's Full Reload is identical to Reload -->
        <button v-if="s.level > 0 && (s.kind !== 'jigsaw' || s.level < s.maxDepth)" :disabled="locked" @click="session.fullReload()">
          <span class="material-symbols-outlined">restart_alt</span>
          Full Reload
        </button>
        <button v-if="s.level > 0" :disabled="locked" @click="session.reset()">
          <span class="material-symbols-outlined">first_page</span>
          Reset
        </button>
      </template>
      <button v-else :disabled="locked" @click="session.generate()">
        <span class="material-symbols-outlined">{{ s.reroll || s.level > 0 ? "shuffle" : "construction" }}</span>
        {{ s.reroll ? "Re-roll" : s.level > 0 ? "Regenerate" : "Generate" }}
      </button>
      <button v-if="mode === 'session' && buildState.hasStructureBlocks" :disabled="locked" @click="buildState.hideStructureBlocks = !buildState.hideStructureBlocks">
        <span class="material-symbols-outlined">{{ buildState.hideStructureBlocks ? "visibility" : "visibility_off" }}</span>
        {{ buildState.hideStructureBlocks ? "Show" : "Hide" }}
      </button>
    </div>
    <button class="head" @click="open = !open">
      <span class="material-symbols-outlined">{{ open ? "expand_more" : "expand_less" }}</span>
      {{ headLabel }}
    </button>
  </div>
</template>

<style scoped>
.level-menu {
  position: absolute;
  right: 14px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

.head { white-space: nowrap; }

.level-menu.locked {
  pointer-events: none;
  opacity: 0.7;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px;
}

.panel.collapsed { visibility: hidden; }

button {
  display: flex;
  align-items: center;
  gap: 6px;
}

.head {
  justify-content: center;
}

button .material-symbols-outlined { font-size: 18px; }
</style>
