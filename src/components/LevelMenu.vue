<script setup>
import { ref } from "vue"
import { useSession } from "../composables/useSession.js"
import { useBuild } from "../composables/useBuild.js"
import { useLock } from "../composables/useLock.js"

const session = useSession()
const s = session.state
const { state: buildState } = useBuild()
const { locked } = useLock()
const open = ref(false)
</script>

<template>
  <div v-if="s.active" class="level-menu" :class="{ locked }">
    <!-- buttons that can't do anything at this level aren't rendered at all.
         collapsed, the panel is hidden but keeps its width so the head button
         stretches to match -->
    <div class="panel" :class="{ collapsed: !open }">
      <template v-if="s.steps">
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
        <span class="material-symbols-outlined">casino</span>
        {{ s.level > 0 ? "Regenerate" : "Generate" }}
      </button>
      <button v-if="buildState.hasStructureBlocks" :disabled="locked" @click="buildState.hideStructureBlocks = !buildState.hideStructureBlocks">
        <span class="material-symbols-outlined">{{ buildState.hideStructureBlocks ? "visibility" : "visibility_off" }}</span>
        {{ buildState.hideStructureBlocks ? "Show" : "Hide" }}
      </button>
    </div>
    <button class="head" @click="open = !open">
      <span class="material-symbols-outlined">{{ open ? "expand_more" : "expand_less" }}</span>
      <!-- the base is just the raw structure: no level shown until you grow -->
      {{ s.steps && s.level > 0 ? `${s.label} · Level ${s.level + 1}` : s.label }}
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
