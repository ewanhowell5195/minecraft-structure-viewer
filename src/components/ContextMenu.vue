<script setup>
import { nextTick, ref, watch } from "vue"
import { useContextMenu } from "../composables/useContextMenu.js"

const { state, close } = useContextMenu()
const el = ref(null)
const pos = ref({ left: 0, top: 0 })

// place at the pointer, then nudge inside the viewport once measured
watch(() => [state.open, state.x, state.y], async () => {
  if (!state.open) return
  pos.value = { left: state.x, top: state.y }
  await nextTick()
  const r = el.value?.getBoundingClientRect()
  if (!r) return
  pos.value = {
    left: Math.max(4, Math.min(state.x, innerWidth - r.width - 4)),
    top: Math.max(4, Math.min(state.y, innerHeight - r.height - 4))
  }
})

// dismiss on any press outside, escape, scroll or leaving the window
addEventListener("pointerdown", e => {
  if (state.open && !el.value?.contains(e.target)) close()
}, true)
addEventListener("keydown", e => {
  if (e.key === "Escape" && state.open) close()
})
addEventListener("wheel", () => { if (state.open) close() }, { capture: true, passive: true })
addEventListener("blur", () => { if (state.open) close() })

function run(item) {
  if (item.disabled) return
  close()
  item.action()
}
</script>

<template>
  <div v-if="state.open" ref="el" class="ctx-menu"
    :style="{ left: pos.left + 'px', top: pos.top + 'px' }" @contextmenu.prevent>
    <button v-for="(it, i) in state.items" :key="i" :disabled="it.disabled" @click="run(it)">
      <span v-if="it.icon" class="material-symbols-outlined">{{ it.icon }}</span>
      {{ it.label }}
    </button>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 200;
  min-width: 170px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 6px 24px #00000080;
  display: flex;
  flex-direction: column;
}

.ctx-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  border-radius: 5px;
  padding: 6px 10px;
  text-align: left;
  font-size: 13px;
}

.ctx-menu button:hover:not(:disabled) { background: #ffffff12; }

.ctx-menu .material-symbols-outlined {
  font-size: 17px;
  color: var(--text-dim);
}
</style>
