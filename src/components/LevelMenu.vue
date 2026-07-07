<script setup>
import { ref } from "vue"
import { useSession } from "../composables/useSession.js"
import { useLock } from "../composables/useLock.js"

const session = useSession()
const s = session.state
const { locked } = useLock()
const open = ref(false)
</script>

<template>
  <div v-if="s.active" class="level-menu" :class="{ locked }">
    <div v-if="open" class="panel">
      <template v-if="s.steps">
        <button :disabled="locked || s.level >= s.maxDepth" @click="session.next()">
          <span class="material-symbols-outlined">skip_next</span>
          Load Next Level
        </button>
        <button :disabled="locked || s.level >= s.maxDepth" @click="session.all()">
          <span class="material-symbols-outlined">fast_forward</span>
          Load All Levels
        </button>
        <button :disabled="locked || s.level === 0" @click="session.undo()">
          <span class="material-symbols-outlined">undo</span>
          Undo Level
        </button>
        <button v-if="s.kind === 'jigsaw'" :disabled="locked || s.level === 0" @click="session.reloadAll()">
          <span class="material-symbols-outlined">refresh</span>
          Reload
        </button>
        <button :disabled="locked" @click="session.fullReload()">
          <span class="material-symbols-outlined">restart_alt</span>
          Full Reload
        </button>
        <button :disabled="locked || s.level === 0" @click="session.reset()">
          <span class="material-symbols-outlined">first_page</span>
          Reset
        </button>
      </template>
      <button v-else :disabled="locked" @click="session.generate()">
        <span class="material-symbols-outlined">casino</span>
        {{ s.level > 0 ? "Regenerate" : "Generate" }}
      </button>
    </div>
    <button class="head" @click="open = !open">
      <span class="material-symbols-outlined">{{ open ? "expand_more" : "expand_less" }}</span>
      {{ s.steps ? `${s.label} · level ${s.level + 1}` : s.label }}
    </button>
  </div>
</template>

<style scoped>
.level-menu {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  min-width: 190px;
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

button {
  display: flex;
  align-items: center;
  gap: 6px;
}

.head {
  justify-content: center;
  background: #000000a0;
}

button .material-symbols-outlined { font-size: 18px; }
</style>
