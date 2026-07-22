<script setup>
import { ref, watch } from "vue"
import * as THREE from "three"
import { useScene } from "../composables/useScene.js"
import { useWalk } from "../composables/useWalk.js"
import { useContainer } from "../composables/useContainer.js"

const sceneApi = useScene()
const { state } = useWalk()
const { state: containerState } = useContainer()
const pos = ref({ left: "50%", top: "50%" })
const rect = ref(null)
const arrow = ref(null)

// camera forward is the CANVAS centre, not the viewport centre (the sidebar offsets the canvas)
function place() {
  const c = document.getElementById("view")
  if (!c) return
  const r = c.getBoundingClientRect()
  pos.value = { left: r.left + r.width / 2 + "px", top: r.top + r.height / 2 + "px" }
  rect.value = { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" }
}
watch(() => state.on, on => { if (on) place() })
watch(() => state.suspended, s => { if (s) place() })
addEventListener("resize", () => { if (state.on) place() })

const _frustum = new THREE.Frustum(), _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _look = new THREE.Vector3()
const wrapPi = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
const asin1 = v => Math.asin(Math.max(-1, Math.min(1, v)))

function tick() {
  requestAnimationFrame(tick)
  const cam = sceneApi.camera, canvas = sceneApi.canvas
  if (!canvas || !sceneApi.contentRoots.size) {
    arrow.value = null
    return
  }
  _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  _frustum.setFromProjectionMatrix(_m)
  const box = sceneApi.sceneBounds()
  if (_frustum.intersectsBox(box)) {
    arrow.value = null
    return
  }
  const r = canvas.getBoundingClientRect()
  box.getCenter(_v)
  let dx, dy
  if (state.on) {
    // pitch clamps at +-90, so a target behind you must read as turn-around,
    // never pitch-further; clamping target y to the box span keeps the arrow level within it
    _v.y = Math.max(box.min.y, Math.min(box.max.y, cam.position.y))
    _v.sub(cam.position).normalize()
    cam.getWorldDirection(_look)
    const dyaw = wrapPi(Math.atan2(-_v.x, -_v.z) - Math.atan2(-_look.x, -_look.z))
    const dpitch = asin1(_v.y) - asin1(_look.y)
    dx = -dyaw
    dy = -dpitch
  } else {
    // screen-space direction: angular deltas overshoot vertically at steep angles
    const behind = _v.applyMatrix4(cam.matrixWorldInverse).z > 0
    _v.applyMatrix4(cam.projectionMatrix)
    dx = _v.x * r.width
    dy = -_v.y * r.height
    if (behind) { dx = -dx; dy = -dy }
  }
  const n = Math.hypot(dx, dy)
  if (n < 1e-6) { dx = 1; dy = 0 } else { dx /= n; dy /= n }
  const t = Math.min((r.width / 2 - 30) / Math.max(Math.abs(dx), 1e-9), (r.height / 2 - 30) / Math.max(Math.abs(dy), 1e-9))
  arrow.value = {
    left: r.left + r.width / 2 + dx * t + "px",
    top: r.top + r.height / 2 + dy * t + "px",
    deg: Math.atan2(dy, dx) * 180 / Math.PI + 90 // glyph points up at 0
  }
}
requestAnimationFrame(tick)
</script>

<template>
  <span v-if="arrow" class="dir-arrow material-symbols-outlined"
    :style="{ left: arrow.left, top: arrow.top, transform: `translate(-50%, -50%) rotate(${arrow.deg}deg)` }">arrow_upward</span>
  <template v-if="state.on && !state.suspended">
    <div class="crosshair" :style="pos"></div>
    <div class="hint" :style="{ left: pos.left }">
      <b>WASD</b> move · <b>mouse</b> look · <b>click</b> open door · <b>space</b> jump · <b>2×space</b> fly ·
      <b>N</b> noclip · <b>scroll</b> fly speed · <b>shift</b> down/sneak · <b>ctrl/Q/2×W</b> sprint · <b>esc</b> exit
    </div>
  </template>
  <div v-if="state.on && state.suspended && !containerState.open" class="paused" :style="rect">
    Click to resume
  </div>
</template>

<style scoped>
/* one difference-blended element so the bars merge to white first: no self-blended black centre */
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

.paused {
  position: fixed;
  z-index: 9;
  background: #00000080;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  color: #eee;
  font-size: 15px;
}
</style>
