import { reactive, watch } from "vue"
import * as THREE from "three"
import { useScene, SLICE_PLANES } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { useStructure } from "./useStructure.js"
import { useLock } from "./useLock.js"

const AXES = ["x", "y", "z"]
const DIRS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
// blockbench's axis colours; lightened line variants so they read on the dark scene
const COLORS = { x: 0xff1242, y: 0x3fc35f, z: 0x0894ed }
const LINE_COLORS = { x: 0xff6b82, y: 0x6cd186, z: 0x45b1f4 }
const FILL_COLORS = { x: 0xff4059, y: 0x3fc35f, z: 0x0894ed }
// into the hidden side, so boundary faces don't speckle against clip-test float jitter
const BIAS = 0.002

// i: boundary index 0..blocks along the axis; flip false hides the +axis side
const state = reactive({
  x: { on: false, i: null, flip: false },
  y: { on: false, i: null, flip: false },
  z: { on: false, i: null, flip: false }
})

const sceneApi = useScene()
const { locked } = useLock()
let box = null
let added = false
const group = new THREE.Group()

// polygon offset keeps the quad just behind coplanar block faces instead of z-fighting them
const quads = {}
for (const a of AXES) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: FILL_COLORS[a], transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8
    })
  )
  mesh.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: LINE_COLORS[a], transparent: true, opacity: 0.5 })
  ))
  if (a === "x") mesh.rotation.y = Math.PI / 2
  if (a === "y") mesh.rotation.x = -Math.PI / 2
  mesh.userData.axis = a
  mesh.visible = false
  group.add(mesh)
  quads[a] = mesh
}

const rails = {}
for (const a of AXES) {
  const seg = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: LINE_COLORS[a], transparent: true, opacity: 0.35 })
  )
  seg.visible = false
  group.add(seg)
  rails[a] = seg
}

const handles = {}
for (const a of AXES) {
  handles[a] = []
  for (let n = 0; n < 4; n++) {
    const h = new THREE.Mesh(
      new THREE.BoxGeometry(14, 14, 14),
      new THREE.MeshBasicMaterial({ visible: false })
    )
    h.add(new THREE.Mesh(
      new THREE.BoxGeometry(6, 6, 6),
      new THREE.MeshBasicMaterial({ color: COLORS[a], transparent: true, opacity: 0.85 })
    ))
    h.userData = { axis: a, corner: n }
    h.visible = false
    group.add(h)
    handles[a].push(h)
  }
}
let railBox = null

function gridCentre() {
  return new THREE.Vector3(
    box.min.x + (box.lo[0] + box.hi[0]) * 8,
    box.min.y + box.blocks[1] * 8,
    box.min.z + (box.lo[2] + box.hi[2]) * 8
  )
}

function refresh() {
  // clip only while previewing ahead of the built cut: a landed slice build has
  // the cut for real, and clipping it too would shave models overhanging their block
  const previewing = sliceKey() !== appliedKey
  AXES.forEach((a, k) => {
    const s = state[a], plane = SLICE_PLANES[k], mesh = quads[a]
    const active = s.on && box && s.i != null
    mesh.visible = !!active
    rails[a].visible = !!active
    if (!active) for (const h of handles[a]) h.visible = false
    if (!active || !previewing) {
      plane.normal.set(0, 1, 0)
      plane.constant = 1e9
      if (!active) return
    }
    const w = box.min.getComponent(k) + s.i * 16
    const dir = s.flip ? 1 : -1
    if (previewing) {
      // keep the side where normal·p + constant >= 0
      plane.normal.copy(DIRS[a]).multiplyScalar(dir)
      plane.constant = -w * dir + BIAS
    }
    const c = gridCentre()
    c.setComponent(k, w)
    mesh.position.copy(c)
    for (const h of handles[a]) {
      h.visible = true
      const p = handleSpot(a, h.userData.corner)
      p.setComponent(k, w)
      h.userData.base = p
      h.position.copy(p)
    }
    const hot = hoverA === a || dragA === a
    mesh.material.opacity = hot ? 0.18 : 0
    mesh.children[0].material.opacity = hot ? 0.9 : 0.5
    rails[a].material.opacity = hot ? 0.7 : 0.35
    for (const h of handles[a]) h.children[0].material.opacity = hot ? 1 : 0.85
  })
}

function handleSpot(a, corner) {
  const { tx, tz, qy } = railBox
  const i = corner >> 1, j = corner & 1
  if (a === "x") return new THREE.Vector3(0, qy[i], tz[j])
  if (a === "y") return new THREE.Vector3(tx[i], 0, tz[j])
  return new THREE.Vector3(tx[i], qy[j], 0)
}

// a plane parked at or past the edge on its hidden side cuts nothing, so it counts inactive
const cuts = (s, k) => s.on && s.i != null && !(box && (s.flip ? s.i <= 0 : s.i >= box.blocks[k]))

const sliceKey = () => {
  const parts = AXES.map((a, k) => {
    const s = state[a]
    return cuts(s, k) ? `${k}:${s.i}:${s.flip ? 1 : 0}` : ""
  })
  return parts.some(Boolean) ? parts.join("|") : ""
}
// "" = the full build; pendingKey is the in-flight build's cut, promoted when it lands
let appliedKey = ""
let pendingKey = ""

function sliceStructure(structure) {
  const act = []
  AXES.forEach((a, k) => {
    const s = state[a]
    if (cuts(s, k)) act.push([k, s.i, s.flip])
  })
  pendingKey = sliceKey()
  if (!act.length) return structure
  const keep = p => act.every(([k, i, flip]) => flip ? p[k] >= i : p[k] < i)
  return {
    ...structure,
    blocks: structure.blocks.filter(b => keep(b.pos)),
    entities: (structure.entities ?? []).filter(e => keep(e.pos.map(Math.floor)))
  }
}

// the settle window lets a follow-up drag start without wasting a rebuild
let rebuildTimer = null
function scheduleRebuild() {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    if (sliceKey() === appliedKey) return
    const buildApi = useBuild()
    if (buildApi.state.building) return scheduleRebuild()
    if (sliceKey() === "" && buildApi.restoreFull()) {
      appliedKey = ""
      refresh()
      return
    }
    buildApi.build(undefined, false, true)
  }, 1000)
}

watch(state, () => {
  if (box) {
    AXES.forEach((a, k) => {
      const s = state[a]
      if (s.on && s.i == null) s.i = box.hi[k]
    })
  }
  refresh()
  useBuild().showFull(sliceKey() !== appliedKey)
  if (!dragA) scheduleRebuild()
}, { deep: true })

function onBuild(root, position, size, sliced) {
  appliedKey = sliced ? pendingKey : ""
  if (!sliced && sliceKey()) scheduleRebuild()
  box = {
    min: new THREE.Vector3(position.x - 8, position.y - 8, position.z - 8),
    blocks: size,
    // x/z run out to the floor grid's edge (3-block border); y spans the structure
    lo: [-3, 0, -3],
    hi: [size[0] + 3, size[1], size[2] + 3]
  }
  if (!added) {
    sceneApi.overlayScene.add(group)
    added = true
  }
  AXES.forEach((a, k) => {
    const s = state[a]
    if (s.i == null) {
      if (s.on) s.i = box.hi[k]
    } else s.i = Math.min(Math.max(s.i, box.lo[k]), box.hi[k])
  })
  const sx = (box.hi[0] - box.lo[0]) * 16
  const sz = (box.hi[2] - box.lo[2]) * 16
  const sy = size[1] * 16
  quads.x.scale.set(sz, sy, 1)
  quads.y.scale.set(sx, sz, 1)
  quads.z.scale.set(sx, sy, 1)
  const tx = [box.min.x + box.lo[0] * 16, box.min.x + box.hi[0] * 16]
  const ty = [box.min.y, box.min.y + size[1] * 16]
  const tz = [box.min.z + box.lo[2] * 16, box.min.z + box.hi[2] * 16]
  const qy = [box.min.y, box.min.y + sy]
  railBox = { tx, ty, tz, qy }
  const P = { x: [], y: [], z: [] }
  for (const i of [0, 1]) {
    for (const j of [0, 1]) {
      P.x.push(tx[0], qy[i], tz[j], tx[1], qy[i], tz[j])
      P.y.push(tx[i], ty[0], tz[j], tx[i], ty[1], tz[j])
      P.z.push(tx[i], qy[j], tz[0], tx[i], qy[j], tz[1])
    }
  }
  for (const a of AXES) {
    rails[a].geometry.dispose()
    rails[a].geometry = new THREE.BufferGeometry()
    rails[a].geometry.setAttribute("position", new THREE.Float32BufferAttribute(P[a], 3))
  }
  refresh()
  root.traverse(o => {
    const m = o.material
    if (!m) return
    for (const mm of Array.isArray(m) ? m : [m]) {
      if (mm.clippingPlanes !== SLICE_PLANES) {
        mm.clippingPlanes = SLICE_PLANES
        mm.needsUpdate = true
      }
    }
  })
}

// hovering a handle unmaps the orbit's left button before the press, so the drag doesn't orbit
const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
let hoverA = null, hoverH = null, dragA = null, dragCorner = 0, savedLeft = null

function pick(e) {
  if (!box) return null
  const canvas = sceneApi.canvas
  const r = canvas.getBoundingClientRect()
  ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(ndc, sceneApi.camera)
  const targets = AXES.filter(a => state[a].on && state[a].i != null).flatMap(a => handles[a])
  if (!targets.length) return null
  return raycaster.intersectObjects(targets, false)[0]?.object ?? null
}

function dragTo(e) {
  const a = dragA, k = AXES.indexOf(a)
  const canvas = sceneApi.canvas
  const r = canvas.getBoundingClientRect()
  ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(ndc, sceneApi.camera)
  // closest point between the pointer ray and the grabbed handle's rail
  const p0 = handleSpot(a, dragCorner)
  p0.setComponent(k, box.min.getComponent(k))
  const u = DIRS[a], v = raycaster.ray.direction
  const w0 = p0.clone().sub(raycaster.ray.origin)
  const b = u.dot(v)
  const denom = 1 - b * b
  if (Math.abs(denom) < 1e-6) return
  const t = (b * v.dot(w0) - u.dot(w0)) / denom
  state[a].i = Math.min(Math.max(Math.round(t / 16), box.lo[k]), box.hi[k])
}

function setHover(a) {
  if (a === hoverA) return
  hoverA = a
  const mb = sceneApi.controls.mouseButtons
  if (a && savedLeft === null) {
    savedLeft = mb.LEFT
    mb.LEFT = null
  }
  if (!a && !dragA && savedLeft !== null) {
    mb.LEFT = savedLeft
    savedLeft = null
  }
  sceneApi.canvas.style.cursor = a ? "grab" : ""
  refresh()
}

// constant screen size, capped so a cube never exceeds a block
function handleScale(h) {
  const cam = sceneApi.camera
  const s = cam.isOrthographicCamera
    ? (cam.top - cam.bottom) / cam.zoom / 450
    : h.position.distanceTo(cam.position) / 500
  return Math.min(s, 16 / 6)
}

function init() {
  const canvas = sceneApi.canvas
  sceneApi.animators.add({
    update() {
      const vis = []
      for (const a of AXES) {
        for (const h of handles[a]) {
          if (!h.visible || !h.userData.base) continue
          h.userData.s = handleScale(h)
          h.userData.tight = false
          h.position.copy(h.userData.base)
          vis.push(h)
        }
      }
      // coincident corner gizmos fan inward along their own rails
      const used = new Array(vis.length).fill(false)
      for (let m = 0; m < vis.length; m++) {
        if (used[m]) continue
        const cluster = [vis[m]]
        for (let n = m + 1; n < vis.length; n++) {
          if (used[n]) continue
          if (vis[m].position.distanceTo(vis[n].position) < (vis[m].userData.s + vis[n].userData.s) * 4) {
            cluster.push(vis[n])
            used[n] = true
          }
        }
        if (cluster.length < 2) continue
        for (const h of cluster) {
          const k = AXES.indexOf(h.userData.axis)
          const centre = box.min.getComponent(k) + (box.lo[k] + box.hi[k]) * 8
          const dir = Math.sign(centre - h.position.getComponent(k)) || 1
          h.position.setComponent(k, h.position.getComponent(k) + dir * h.userData.s * 8)
          h.userData.tight = true
        }
      }
      // fanned hitboxes shrink; the child inverts the scale so the visible cube never changes size
      for (const h of vis) {
        const f = h.userData.tight ? 0.5 : 1
        h.scale.setScalar(h.userData.s * f)
        h.children[0].scale.setScalar(1 / f)
      }
    }
  })
  // sync flush, so the reset lands before the new load's build slices
  const reset = () => {
    clearTimeout(rebuildTimer)
    for (const a of AXES) {
      state[a].on = false
      state[a].i = null
      state[a].flip = false
    }
  }
  watch(() => useStructure().state.name, reset, { flush: "sync" })
  // a static import would evaluate useSession mid useBuild module eval
  // (build -> slicers -> session -> build) and trip its top-level useBuild()
  import("./useSession.js").then(({ useSession }) => {
    watch(() => [useSession().state.level, useSession().state.seed], reset, { flush: "sync" })
  })
  canvas.addEventListener("pointerdown", e => {
    if (e.button !== 0 || document.pointerLockElement || locked.value || !hoverA) return
    dragA = hoverA
    dragCorner = hoverH?.userData.corner ?? 0
    clearTimeout(rebuildTimer)
    useBuild().showFull(sliceKey() !== appliedKey)
    canvas.setPointerCapture(e.pointerId)
    canvas.style.cursor = "grabbing"
    refresh()
  })
  canvas.addEventListener("pointermove", e => {
    if (document.pointerLockElement) return
    if (dragA) {
      if (!locked.value) dragTo(e)
      return
    }
    hoverH = e.buttons || locked.value ? null : pick(e)
    setHover(hoverH?.userData.axis ?? null)
  })
  const end = e => {
    if (!dragA) return
    dragA = null
    canvas.releasePointerCapture?.(e.pointerId)
    hoverH = pick(e)
    setHover(hoverH?.userData.axis ?? null)
    canvas.style.cursor = hoverA ? "grab" : ""
    refresh()
    useBuild().showFull(sliceKey() !== appliedKey)
    scheduleRebuild()
  }
  canvas.addEventListener("pointerup", end)
  canvas.addEventListener("pointercancel", end)
  canvas.addEventListener("pointerleave", () => { if (!dragA) setHover(null) })
}

const busy = () => !!(hoverA || dragA)

export function useSlicers() {
  return { state, init, onBuild, busy, sliceStructure }
}
