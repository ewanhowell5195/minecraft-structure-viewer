<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from "vue"
import { useContextMenu } from "../composables/useContextMenu.js"

const { state, close } = useContextMenu()
const el = ref(null)
const pos = ref({ left: 0, top: 0 })

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

function onPointerDown(e) {
  if (state.open && !el.value?.contains(e.target)) close()
}
function onKey(e) {
  if (e.key === "Escape" && state.open) close()
}
const closeIfOpen = () => { if (state.open) close() }

addEventListener("pointerdown", onPointerDown, true)
addEventListener("keydown", onKey)
addEventListener("wheel", closeIfOpen, { capture: true, passive: true })
addEventListener("blur", closeIfOpen)
onBeforeUnmount(() => {
  removeEventListener("pointerdown", onPointerDown, true)
  removeEventListener("keydown", onKey)
  removeEventListener("wheel", closeIfOpen, { capture: true })
  removeEventListener("blur", closeIfOpen)
})

function run(item) {
  if (item.disabled) return
  close()
  item.action()
}
</script>

<template>
  <div v-if="state.open" ref="el" class="ctx-menu menu-panel"
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
}
</style>
