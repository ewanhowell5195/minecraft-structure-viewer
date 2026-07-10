import { reactive, watch } from "vue"
import * as THREE from "three"
import { useScene, SLICE_PLANES } from "./useScene.js"

// Scene slicers: one per axis, each a plane dragged through the structure
// snapping to block boundaries, hiding everything on one side. Slicing is
// render-side (clipping planes on the structure's materials), so moving a
// plane never rebuilds anything and the cut exposes the meshed shell.
const AXES = ["x", "y", "z"]
const DIRS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
const COLOR = 0x4c8dff
const PAD = 32

// per axis: enabled, boundary index (0..blocks along that axis), and which
// side hides (false hides the +axis side: "above" for y)
const state = reactive({
  x: { on: false, i: null, flip: false },
  y: { on: false, i: null, flip: false },
  z: { on: false, i: null, flip: false }
})

const sceneApi = useScene()
let box = null // { min: Vector3 (world corner), blocks: [nx, ny, nz] }
let added = false
const group = new THREE.Group()

// the polygon offset settles coplanar block faces in front of the quad, so
// it draws just behind whatever it clips instead of z-fighting it
const quads = {}
for (const a of AXES) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: COLOR, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4
    })
  )
  mesh.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: COLOR, transparent: true, opacity: 0.5 })
  ))
  if (a === "x") mesh.rotation.y = Math.PI / 2
  if (a === "y") mesh.rotation.x = -Math.PI / 2
  mesh.userData.axis = a
  mesh.visible = false
  group.add(mesh)
  quads[a] = mesh
}

// the quads centre on the floor grid, standing on its plane
function gridCentre() {
  return new THREE.Vector3(
    box.min.x + (box.lo[0] + box.hi[0]) * 8,
    box.min.y + (box.blocks[1] * 16 + PAD) / 2,
    box.min.z + (box.lo[2] + box.hi[2]) * 8
  )
}

function refresh() {
  AXES.forEach((a, k) => {
    const s = state[a], plane = SLICE_PLANES[k], mesh = quads[a]
    const active = s.on && box
    mesh.visible = !!active
    if (!active) {
      plane.normal.set(0, 1, 0)
      plane.constant = 1e9
      return
    }
    const w = box.min.getComponent(k) + s.i * 16
    // keep the side where normal·p + constant >= 0
    const dir = s.flip ? 1 : -1
    plane.normal.copy(DIRS[a]).multiplyScalar(dir)
    plane.constant = -w * dir
    const c = gridCentre()
    c.setComponent(k, w)
    mesh.position.copy(c)
    const hot = hoverA === a || dragA === a
    mesh.material.opacity = hot ? 0.22 : 0.1
    mesh.children[0].material.opacity = hot ? 0.9 : 0.5
  })
}

watch(state, refresh, { deep: true })

// called by useBuild after each build: size the quads to the new structure,
// keep positions (clamped), and hand the clipping planes to every material
function onBuild(root, position, size) {
  box = {
    min: new THREE.Vector3(position.x - 8, position.y - 8, position.z - 8),
    blocks: size,
    // x/z run out to the floor grid's edge (3-block border, 4 on the odd
    // side); y spans the structure
    lo: [-3, 0, -3],
    hi: [size[0] + 3 + size[0] % 2, size[1], size[2] + 3 + size[2] % 2]
  }
  if (!added) {
    sceneApi.overlayScene.add(group)
    added = true
  }
  AXES.forEach((a, k) => {
    const s = state[a]
    s.i = s.i == null ? Math.round(size[k] / 2) : Math.min(Math.max(s.i, box.lo[k]), box.hi[k])
  })
  // the quads stretch across the whole floor grid
  const sx = (box.hi[0] - box.lo[0]) * 16
  const sz = (box.hi[2] - box.lo[2]) * 16
  const sy = size[1] * 16 + PAD
  quads.x.scale.set(sz, sy, 1)
  quads.y.scale.set(sx, sz, 1)
  quads.z.scale.set(sx, sy, 1)
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

// ---- viewport interaction: hovering a plane unmaps the orbit's left
// button before the press, so a drag moves the plane (snapping block by
// block along its axis) while zoom and right-button pan keep working

const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
let hoverA = null, dragA = null, savedLeft = null

function pick(e) {
  if (!box) return null
  const canvas = sceneApi.canvas
  const r = canvas.getBoundingClientRect()
  ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(ndc, sceneApi.camera)
  const targets = AXES.filter(a => state[a].on).map(a => quads[a])
  if (!targets.length) return null
  return raycaster.intersectObjects(targets, false)[0]?.object.userData.axis ?? null
}

function dragTo(e) {
  const a = dragA, k = AXES.indexOf(a)
  const canvas = sceneApi.canvas
  const r = canvas.getBoundingClientRect()
  ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(ndc, sceneApi.camera)
  // closest point between the pointer ray and the plane's axis line
  const p0 = gridCentre()
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

function init() {
  const canvas = sceneApi.canvas
  canvas.addEventListener("pointerdown", e => {
    if (e.button !== 0 || document.pointerLockElement || !hoverA) return
    dragA = hoverA
    canvas.setPointerCapture(e.pointerId)
    canvas.style.cursor = "grabbing"
    refresh()
  })
  canvas.addEventListener("pointermove", e => {
    if (document.pointerLockElement) return
    if (dragA) {
      dragTo(e)
      return
    }
    setHover(e.buttons ? null : pick(e))
  })
  const end = e => {
    if (!dragA) return
    dragA = null
    canvas.releasePointerCapture?.(e.pointerId)
    setHover(pick(e))
    canvas.style.cursor = hoverA ? "grab" : ""
    refresh()
  }
  canvas.addEventListener("pointerup", end)
  canvas.addEventListener("pointercancel", end)
  canvas.addEventListener("pointerleave", () => { if (!dragA) setHover(null) })
}

// container picking stands down while a plane is hovered or dragged
const busy = () => !!(hoverA || dragA)

export function useSlicers() {
  return { state, init, onBuild, busy }
}
