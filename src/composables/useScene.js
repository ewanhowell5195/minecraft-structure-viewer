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

// floor grids: one rectangular grid per structure, hugging its footprint.
// dimensions are even block counts so the brighter centre cross lands on a
// block boundary
let gridGroup = null
const gridVisible = () => view.grid && !view.wireframe
const GRID_LINE = 0x333336

function makeRectGrid({ x, z, w, d, y }) {
  const P = [], C = []
  const cross = new THREE.Color(GRID_COLOR), line = new THREE.Color(GRID_LINE)
  const push = c => C.push(c.r, c.g, c.b, c.r, c.g, c.b)
  for (let i = 0; i <= w; i++) {
    P.push(x + i * 16, y, z, x + i * 16, y, z + d * 16)
    push(i * 2 === w ? cross : line)
  }
  for (let j = 0; j <= d; j++) {
    P.push(x, y, z + j * 16, x + w * 16, y, z + j * 16)
    push(j * 2 === d ? cross : line)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3))
  geo.setAttribute("color", new THREE.Float32BufferAttribute(C, 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }))
}

// rects: [{ x, z, y, w, d }] with x/z/y in world units and w/d in blocks
function setGrids(rects) {
  if (gridGroup) {
    gridGroup.removeFromParent()
    gridGroup.traverse(o => {
      o.geometry?.dispose()
      o.material?.dispose?.()
    })
  }
  gridGroup = new THREE.Group()
  gridGroup.visible = gridVisible()
  for (const r of rects) gridGroup.add(makeRectGrid(r))
  scene.add(gridGroup)
}

const _bb = new THREE.Box3()
function sceneBounds() {
  _bb.makeEmpty()
  for (const r of contentRoots) _bb.expandByObject(r)
  if (_bb.isEmpty()) _bb.set(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8))
  return _bb
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

// resize when the CSS size or device pixel ratio changes, and also when the
// buffer itself no longer matches: browsers can shrink or drop a hidden
// tab's backing store, which used to be silently repaired by the old
// setSize-every-frame bug
let sizeW = 0, sizeH = 0
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight
  const ratio = Math.min(window.devicePixelRatio * 2, 4)
  if (w !== sizeW || h !== sizeH || renderer.getPixelRatio() !== ratio || canvas.width !== Math.floor(w * ratio)) {
    sizeW = w
    sizeH = h
    renderer.setPixelRatio(ratio)
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
  setGrids([{ x: -128, z: -128, y: -8.01, w: 16, d: 16 }])
  new ResizeObserver(resize).observe(canvas)

  watch(() => view.wireframe, on => {
    scene.overrideMaterial = on ? wireMat : null
    if (gridGroup) gridGroup.visible = gridVisible()
  })
  watch(() => view.grid, () => { if (gridGroup) gridGroup.visible = gridVisible() })

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
    view, scene, init, fit, setGrids, sceneBounds, setOrtho, setOrthoManual,
    contentRoots, animators, perspCam, FOV, updateProjection, setWalkUpdate,
    get camera() { return camera },
    get controls() { return controls },
    get canvas() { return canvas },
    get renderer() { return renderer }
  }
}
