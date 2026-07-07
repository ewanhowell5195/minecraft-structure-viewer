<script setup>
import { ref } from "vue"

const fps = ref("")
let frames = 0, last = performance.now()
requestAnimationFrame(function tick() {
  requestAnimationFrame(tick)
  frames++
  const now = performance.now()
  if (now - last >= 500) {
    fps.value = String(Math.round(frames * 1000 / (now - last)))
    frames = 0
    last = now
  }
})
</script>

<template>
  <div class="fps">{{ fps }}</div>
</template>

<style scoped>
.fps {
  position: absolute;
  top: 12px;
  right: 14px;
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.5;
  pointer-events: none;
  user-select: none;
}
</style>
