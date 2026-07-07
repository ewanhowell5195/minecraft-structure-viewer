import { reactive, watch } from "vue"
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"

// The three.js scene: renderer, cameras, controls, grid, wireframe, and the
// render loop. Content roots (the built structure, later collected ones) are
// registered so fit/grid can span everything.
const FOV = 45
const GRID_COLOR = 0x444448

const view = reactive({
  ortho: false,
  wireframe: false,
  grid: true
})

let renderer = null, canvas = null
const scene = new THREE.Scene()
const perspCam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 5000)
perspCam.position.set(60, 45, 60)
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000)
let camera = perspCam
let controls = null
let orthoHalfH = 40
let orthoManual = false

const contentRoots = new Set()
const animators = new Set()

const wireMat = new THREE.MeshBasicMaterial({ wireframe: true, color: 0x9fd0ff })

let grid = null
const gridVisible = () => view.grid && !view.wireframe
function makeGrid(span) {
  if (grid) { grid.removeFromParent(); grid.geometry.dispose(); grid.material.dispose() }
  grid = new THREE.GridHelper(span, span / 16, GRID_COLOR, 0x333336)
  grid.visible = gridVisible()
  scene.add(grid)
}

const _bb = new THREE.Box3()
function sceneBounds() {
  _bb.makeEmpty()
  for (const r of contentRoots) _bb.expandByObject(r)
  if (_bb.isEmpty()) _bb.set(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8))
  return _bb
}

// grid lines land on block boundaries: span is a multiple of 16 and the
// position snaps to whole cells
function remakeGrid() {
  const box = sceneBounds()
  const span = Math.max(64, Math.ceil(Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 64) * 64 + 64)
  makeGrid(span)
  const s16 = v => Math.round(v / 16) * 16
  grid.position.set(s16((box.min.x + box.max.x) / 2), box.min.y - 0.01, s16((box.min.z + box.max.z) / 2))
}

function updateProjection() {
  const aspect = (canvas?.clientWidth || 1) / (canvas?.clientHeight || 1)
  if (camera.isPerspectiveCamera) camera.aspect = aspect
  else {
    camera.top = orthoHalfH; camera.bottom = -orthoHalfH
    camera.left = -orthoHalfH * aspect; camera.right = orthoHalfH * aspect
  }
  camera.updateProjectionMatrix()
}

function setOrtho(on, halfH) {
  const to = on ? orthoCam : perspCam
  if (to !== camera) {
    to.position.copy(camera.position)
    to.up.copy(camera.up)
    to.zoom = camera.zoom
    camera = to
    controls.object = to
  }
  if (on) orthoHalfH = halfH ?? camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(FOV / 2))
  updateProjection()
  controls.update()
  view.ortho = on
}

function fit() {
  if (!contentRoots.size) return
  const sphere = sceneBounds().getBoundingSphere(new THREE.Sphere())
  const radius = Math.max(sphere.radius, 8)
  const dist = radius / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * 1.1
  camera.up.set(0, 1, 0)
  camera.zoom = 1
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(30), THREE.MathUtils.degToRad(225), 0, "XYZ")).invert()
  camera.position.copy(sphere.center).add(new THREE.Vector3(0, 0, dist).applyQuaternion(q))
  controls.target.copy(sphere.center)
  camera.lookAt(sphere.center)
  orthoHalfH = radius * 1.1
  updateProjection()
  controls.update()
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight
  if (w !== canvas.width || h !== canvas.height) {
    renderer.setSize(w, h, false)
    updateProjection()
  }
}

function init(canvasEl) {
  canvas = canvasEl
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio * 2, 4))
  controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  // a camera move reverts auto-enabled ortho; a manual toggle sticks
  controls.addEventListener("start", () => { if (camera === orthoCam && !orthoManual) setOrtho(false) })
  makeGrid(256)
  new ResizeObserver(resize).observe(canvas)

  watch(() => view.wireframe, on => {
    scene.overrideMaterial = on ? wireMat : null
    grid.visible = gridVisible()
  })
  watch(() => view.grid, () => { grid.visible = gridVisible() })

  let lastT = performance.now()
  requestAnimationFrame(function frame() {
    requestAnimationFrame(frame)
    const now = performance.now()
    const dt = (now - lastT) / 1000
    lastT = now
    resize()
    // while walking, the walk sim drives the camera instead of the orbit
    if (!walkUpdate?.(dt)) controls.update()
    for (const a of animators) a.update()
    renderer.render(scene, camera)
  })
}

// walk mode's per-frame hook: returns true while it owns the camera
let walkUpdate = null
const setWalkUpdate = fn => { walkUpdate = fn }

function setOrthoManual(on) {
  orthoManual = on
  setOrtho(on)
}

export function useScene() {
  return {
    view, scene, init, fit, remakeGrid, sceneBounds, setOrtho, setOrthoManual,
    contentRoots, animators, perspCam, FOV, updateProjection, setWalkUpdate,
    get camera() { return camera },
    get controls() { return controls },
    get canvas() { return canvas }
  }
}
