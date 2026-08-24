<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useCompare } from "../composables/useCompare.js"
import { useContainer } from "../composables/useContainer.js"

const { state, stateMut, stop } = useCompare()
const container = useContainer()
const el = ref(null)
const dragging = ref(false)

const left = computed(() => `${state.split * 100}%`)

function move(e) {
  const box = el.value?.parentElement?.getBoundingClientRect()
  if (!box) return
  stateMut.split = Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1)
}

function down(e) {
  dragging.value = true
  try { e.target.setPointerCapture(e.pointerId) } catch {}
  move(e)
}

function up(e) {
  if (!dragging.value) return
  dragging.value = false
  try { e.target.releasePointerCapture(e.pointerId) } catch {}
}

// a modal's own Escape must not tear the comparison down with it
function onKey(e) {
  if (e.key === "Escape" && state.on && !container.state.open) stop()
}

onMounted(() => addEventListener("keydown", onKey))
onBeforeUnmount(() => removeEventListener("keydown", onKey))
</script>

<template>
  <div v-if="state.on" ref="el" class="compare" :class="{ dragging }">
    <div v-if="state.view === 'slide'" class="divider" :style="{ left }" @pointerdown.prevent="down" @pointermove="dragging && move($event)" @pointerup="up" @pointercancel="up">
      <div class="grip">
        <span class="material-symbols-outlined">code</span>
      </div>
    </div>
    <button class="quit" title="Stop comparing" @click="stop">
      <span class="material-symbols-outlined">close</span>
      Exit Compare
    </button>
  </div>
</template>

<style scoped>
.compare {
  position: absolute;
  inset: 0;
  z-index: 55;
  pointer-events: none;
}

.divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: #ffffffcc;
  pointer-events: auto;
  cursor: ew-resize;
  touch-action: none;
  user-select: none;
}

.grip {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text-dim);
}

.grip .material-symbols-outlined { font-size: 18px; }

.dragging .grip { border-color: var(--accent, #4c9aff); }

.quit {
  position: absolute;
  right: 14px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
}

.quit .material-symbols-outlined { font-size: 18px; }
</style>
