<script setup>
import { ref, watch } from "vue"
import * as THREE from "three"
import { useScene } from "../composables/useScene.js"
import { useWalk } from "../composables/useWalk.js"

const sceneApi = useScene()
const { state } = useWalk()
const pos = ref({ left: "50%", top: "50%" })
const arrow = ref(null)

// the crosshair marks the camera's forward, which is the CANVAS centre, not
// the viewport centre (the sidebar offsets the canvas)
function place() {
  const c = document.getElementById("view")
  if (!c) return
  const r = c.getBoundingClientRect()
  pos.value = { left: r.left + r.width / 2 + "px", top: r.top + r.height / 2 + "px" }
}
watch(() => state.on, on => { if (on) { place(); requestAnimationFrame(tick) } else arrow.value = null })
addEventListener("resize", () => { if (state.on) place() })

// when no part of the structure is in the camera frustum, point an arrow at
// the canvas edge toward it: camera-space x/y of the bounds centre says which
// way to turn (and still does when the target is behind you)
const _frustum = new THREE.Frustum(), _m = new THREE.Matrix4(), _v = new THREE.Vector3()

function tick() {
  if (!state.on) return
  requestAnimationFrame(tick)
  const cam = sceneApi.perspCam, canvas = sceneApi.canvas
  if (!canvas) return
  _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  _frustum.setFromProjectionMatrix(_m)
  const box = sceneApi.sceneBounds()
  if (_frustum.intersectsBox(box)) {
    arrow.value = null
    return
  }
  box.getCenter(_v).applyMatrix4(cam.matrixWorldInverse)
  let dx = _v.x, dy = -_v.y // CSS y grows downward
  const n = Math.hypot(dx, dy)
  if (n < 1e-6) { dx = 1; dy = 0 } else { dx /= n; dy /= n }
  const r = canvas.getBoundingClientRect()
  const t = Math.min((r.width / 2 - 30) / Math.max(Math.abs(dx), 1e-9), (r.height / 2 - 30) / Math.max(Math.abs(dy), 1e-9))
  arrow.value = {
    left: r.left + r.width / 2 + dx * t + "px",
    top: r.top + r.height / 2 + dy * t + "px",
    deg: Math.atan2(dy, dx) * 180 / Math.PI + 90 // glyph points up at 0
  }
}
</script>

<template>
  <template v-if="state.on">
    <div class="crosshair" :style="pos"></div>
    <span v-if="arrow" class="dir-arrow material-symbols-outlined"
      :style="{ left: arrow.left, top: arrow.top, transform: `translate(-50%, -50%) rotate(${arrow.deg}deg)` }">arrow_upward</span>
    <div class="hint" :style="{ left: pos.left }">
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

.dir-arrow {
  position: fixed;
  pointer-events: none;
  z-index: 10;
  font-size: 28px;
  color: #fff;
  text-shadow: 0 0 4px #000, 0 0 8px #000;
}

.hint {
  position: fixed;
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
