<script setup>
import { ref, watch } from "vue"
import { useWalk } from "../composables/useWalk.js"

const { state } = useWalk()
const pos = ref({ left: "50%", top: "50%" })

// the crosshair marks the camera's forward, which is the CANVAS centre, not
// the viewport centre (the sidebar offsets the canvas)
function place() {
  const c = document.getElementById("view")
  if (!c) return
  const r = c.getBoundingClientRect()
  pos.value = { left: r.left + r.width / 2 + "px", top: r.top + r.height / 2 + "px" }
}
watch(() => state.on, on => { if (on) place() })
addEventListener("resize", () => { if (state.on) place() })
</script>

<template>
  <template v-if="state.on">
    <div class="crosshair" :style="pos"></div>
    <div class="hint">
      <b>WASD</b> move · <b>mouse</b> look · <b>click</b> open door · <b>space</b> jump · <b>2×space</b> fly ·
      <b>N</b> noclip · <b>shift</b> down/sneak · <b>ctrl/Q/2×W</b> sprint · <b>esc</b> exit
    </div>
  </template>
</template>

<style scoped>
/* single element (two gradient bars) with one difference blend, so the bars
   merge to white before inverting the canvas: no self-blended black centre */
.crosshair {
  position: fixed;
  width: 18px;
  height: 18px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 10;
  mix-blend-mode: difference;
  background:
    linear-gradient(#fff, #fff) center / 2px 100% no-repeat,
    linear-gradient(#fff, #fff) center / 100% 2px no-repeat;
}

.hint {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  background: #000000aa;
  color: #eee;
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 12px;
  pointer-events: none;
  z-index: 10;
  white-space: nowrap;
}

.hint b { color: #6fd487; }
</style>
