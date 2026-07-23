import { reactive, watch } from "vue"
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"

// owns the render loop; hot-updating this module would start a second one
if (import.meta.hot) import.meta.hot.decline()

const FOV = 45
const GRID_COLOR = 0x444448

const view = reactive({
  ortho: false,
  wireframe: "off",
  grid: true
})

let renderer = null, canvas = null
const scene = new THREE.Scene()
// drawn over the finished frame; the wireframe override material never touches it
const overlayScene = new THREE.Scene()
// near 2: at 0.1 far surfaces quantised to the same depth (distant z-fighting);
// walking never gets closer than ~4 units, so nothing visible clips
const perspCam = new THREE.PerspectiveCamera(FOV, 1, 2, 5000)
perspCam.position.set(-68, 50, -68)
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000)
let camera = perspCam
let controls = null
let orthoHalfH = 40
let orthoManual = false

const contentRoots = new Set()
const animators = new Set()

// always three so materials compile once; disabled ones pushed out to infinity
export const SLICE_PLANES = [
  new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e9),
  new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e9),
  new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e9)
]

const wireMat = new THREE.MeshBasicMaterial({ wireframe: true, color: 0x9fd0ff })
wireMat.clippingPlanes = SLICE_PLANES

let gridGroup = null
const gridVisible = () => view.grid && view.wireframe !== "wire"
const GRID_LINE = 0x333336

function makeRectGrid({ x, z, w, d, y }, inCave) {
  const P = [], C = []
  const cross = new THREE.Color(GRID_COLOR), line = new THREE.Color(GRID_LINE)
  const push = c => C.push(c.r, c.g, c.b, c.r, c.g, c.b)
  const runs = (span, hidden) => {
    if (!inCave) return [[0, span]]
    const out = []
    let start = null
    for (let i = 0; i < span; i++) {
      if (!hidden(i)) { if (start === null) start = i }
      else if (start !== null) { out.push([start, i]); start = null }
    }
    if (start !== null) out.push([start, span])
    return out
  }
  const crossX = Math.floor(w / 2), crossZ = Math.floor(d / 2)
  for (let i = 0; i <= w; i++) {
    const lx = x + i * 16
    for (const [a, b] of runs(d, j => inCave(lx - 8, z + j * 16 + 8) || inCave(lx + 8, z + j * 16 + 8))) {
      P.push(lx, y, z + a * 16, lx, y, z + b * 16)
      push(i === crossX ? cross : line)
    }
  }
  for (let j = 0; j <= d; j++) {
    const lz = z + j * 16
    for (const [a, b] of runs(w, i => inCave(x + i * 16 + 8, lz - 8) || inCave(x + i * 16 + 8, lz + 8))) {
      P.push(x + a * 16, y, lz, x + b * 16, y, lz)
      push(j === crossZ ? cross : line)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3))
  geo.setAttribute("color", new THREE.Float32BufferAttribute(C, 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }))
}

const CAVE_LINE = 0x3d5464
function makeCaveWire({ segments, y0, y1 }) {
  const P = []
  for (const [x0, z0, x1, z1] of segments) {
    P.push(x0, y0, z0, x1, y0, z1)
    P.push(x0, y1, z0, x1, y1, z1)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: CAVE_LINE }))
}

function makeNorth({ x, z, y, w, d }) {
  const nx = x + Math.floor(w / 2) * 16, x0 = nx - 2.5, x1 = nx + 2.5, zb = z - 3, zt = z - 9
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute([x0, y, zb, x0, y, zt, x0, y, zt, x1, y, zb, x1, y, zb, x1, y, zt], 3))
  const seg = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x62626a }))
  seg.userData = { at: new THREE.Vector3(nx, y, z - 6), showDist: 700 }
  return seg
}

function makeNameTag({ x, z, y, w, d, label }) {
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true }))
  spr.visible = false
  spr.position.set(x + Math.floor(w / 2) * 16, y + 6, z - 6)
  spr.userData = { at: spr.position, showDist: 450, fades: true, ready: false }
  drawNameTag(spr, label)
  return spr
}

async function drawNameTag(spr, label) {
  let mf, font
  try {
    mf = await import("../mcfont.js")
    font = await mf.getFont()
  } catch { return }
  const { measure, drawText } = mf
  const S = 4, pad = S * 2
  const c = document.createElement("canvas")
  c.width = Math.ceil(measure(font, label) * S) + pad * 2
  c.height = font.ch * S + pad * 2
  const ctx = c.getContext("2d")
  ctx.fillStyle = "#00000059"
  ctx.fillRect(0, 0, c.width, c.height)
  drawText(ctx, font, label, pad, pad, { scale: S })
  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  spr.material.map = tex
  spr.material.needsUpdate = true
  const H = 7
  spr.scale.set(H * c.width / c.height, H, 1)
  spr.userData.ready = true
}

function makeHighlight() {
  const box = new THREE.Box3()
  const geo = new THREE.BufferGeometry()
  const pos = new THREE.BufferAttribute(new Float32Array(12 * 6), 3)
  pos.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute("position", pos)
  const mat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneMinusDstColorFactor,
    blendDst: THREE.ZeroFactor
  })
  const lines = new THREE.LineSegments(geo, mat)
  lines.renderOrder = 999
  lines.frustumCulled = false
  lines.visible = false
  scene.add(lines)
  // [cornerBitmaskA, cornerBitmaskB, faceA, faceB], faces -x,+x,-y,+y,-z,+z;
  // an edge draws when either adjacent face looks at the camera
  const EDGES = [
    [0, 1, 2, 4], [2, 3, 3, 4], [4, 5, 2, 5], [6, 7, 3, 5],
    [0, 2, 0, 4], [1, 3, 1, 4], [4, 6, 0, 5], [5, 7, 1, 5],
    [0, 4, 0, 2], [1, 5, 1, 2], [2, 6, 0, 3], [3, 7, 1, 3]
  ]
  lines.onBeforeRender = (renderer, sc, cam) => {
    const vis = []
    for (let f = 0; f < 6; f++) {
      const axis = f >> 1, sign = f & 1 ? 1 : -1
      const plane = sign > 0 ? box.max.getComponent(axis) : box.min.getComponent(axis)
      vis[f] = sign * (cam.position.getComponent(axis) - plane) > 0
    }
    const a = pos.array
    let n = 0
    function put(ci) {
      a[n++] = ci & 1 ? box.max.x : box.min.x
      a[n++] = ci & 2 ? box.max.y : box.min.y
      a[n++] = ci & 4 ? box.max.z : box.min.z
    }
    for (const [c1, c2, f1, f2] of EDGES) {
      if (vis[f1] || vis[f2]) {
        put(c1)
        put(c2)
      }
    }
    geo.setDrawRange(0, n / 3)
    pos.needsUpdate = true
  }
  return {
    show(b) {
      box.copy(b)
      lines.visible = true
    },
    hide() { lines.visible = false }
  }
}

// ortho "zoom" moves no closer, so divide it out
function updateGridLabels() {
  if (!gridGroup) return
  for (const o of gridGroup.children) {
    const u = o.userData
    if (!u.showDist) continue
    const dist = camera.position.distanceTo(u.at) / (camera.zoom || 1)
    if (u.fades) {
      if (!u.ready) { o.visible = false; continue }
      const f = Math.min(Math.max((u.showDist - dist) / (u.showDist * 0.15), 0), 1)
      o.visible = f > 0
      o.material.opacity = f
    } else o.visible = dist < u.showDist
  }
}

let gridRects = []

// rects x/z/y are world units, w/d are blocks; cave is world units
function setGrids(rects, cave = null) {
  gridRects = rects.map(r => ({ x0: r.x, z0: r.z, x1: r.x + r.w * 16, z1: r.z + r.d * 16, y: r.y ?? 0 }))
  if (gridGroup) {
    gridGroup.removeFromParent()
    gridGroup.traverse(o => {
      o.geometry?.dispose()
      o.material?.map?.dispose?.()
      o.material?.dispose?.()
    })
  }
  gridGroup = new THREE.Group()
  gridGroup.visible = gridVisible()
  for (const r of rects) {
    gridGroup.add(makeRectGrid(r, cave?.has))
    gridGroup.add(r.label ? makeNameTag(r) : makeNorth(r))
  }
  if (cave) gridGroup.add(makeCaveWire(cave))
  scene.add(gridGroup)
  refreshSphere()
}

const _bb = new THREE.Box3()
function sceneBounds() {
  _bb.makeEmpty()
  for (const r of contentRoots) _bb.expandByObject(r)
  if (_bb.isEmpty()) {
    if (gridRects.length) {
      for (const r of gridRects) {
        _bb.expandByPoint(new THREE.Vector3(r.x0, r.y, r.z0))
        _bb.expandByPoint(new THREE.Vector3(r.x1, r.y + 16, r.z1))
      }
    } else {
      _bb.set(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8))
    }
  }
  return _bb
}

const sceneSphere = new THREE.Sphere(new THREE.Vector3(), 300)
const refreshSphere = () => sceneBounds().getBoundingSphere(sceneSphere)
function updateClips() {
  const far = Math.max((camera.position.distanceTo(sceneSphere.center) + sceneSphere.radius) * 1.2, 5000)
  if (Math.abs(camera.far - far) > far * 0.01) {
    camera.far = far
    camera.updateProjectionMatrix()
  }
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
  sceneSphere.copy(sphere)
  const radius = Math.max(sphere.radius, 8)
  const dist = radius / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * 1.1
  camera.up.set(0, 1, 0)
  camera.zoom = 1
  camera.position.copy(sphere.center).addScaledVector(new THREE.Vector3(-34, 25, -34).normalize(), dist)
  controls.target.copy(sphere.center)
  camera.lookAt(sphere.center)
  orthoHalfH = radius * 1.1
  updateProjection()
  controls.update()
}

// the end portal shader assumes a square viewport; Aspect squashes the pattern back
function syncAspect() {
  const aspect = (canvas?.clientWidth || 1) / (canvas?.clientHeight || 1)
  scene.traverse(o => {
    for (const mat of [].concat(o.material ?? [])) {
      if (mat?.uniforms?.Aspect) mat.uniforms.Aspect.value = aspect
    }
  })
}

// also check the buffer itself: browsers can shrink or drop a hidden tab's backing store
let sizeW = 0, sizeH = 0, needResize = true
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight
  const ratio = Math.min(window.devicePixelRatio * 2, 4)
  if (w !== sizeW || h !== sizeH || renderer.getPixelRatio() !== ratio || canvas.width !== Math.floor(w * ratio)) {
    sizeW = w
    sizeH = h
    renderer.setPixelRatio(ratio)
    renderer.setSize(w, h, false)
    updateProjection()
    syncAspect()
  }
}
// clientWidth reads force layout, so the per-frame path avoids them: the
// observer flags real size changes and the buffer check runs on cached sizes
function resizeIfNeeded() {
  const ratio = Math.min(window.devicePixelRatio * 2, 4)
  if (needResize || renderer.getPixelRatio() !== ratio || canvas.width !== Math.floor(sizeW * ratio)) {
    needResize = false
    resize()
  }
}

function init(canvasEl) {
  canvas = canvasEl
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false })
  renderer.debug.checkShaderErrors = false
  renderer.setPixelRatio(Math.min(window.devicePixelRatio * 2, 4))
  renderer.localClippingEnabled = true
  controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.addEventListener("start", () => { if (camera === orthoCam && !orthoManual) setOrtho(false) })
  setGrids([{ x: -128, z: -128, y: -8.01, w: 16, d: 16 }])
  new ResizeObserver(() => { needResize = true }).observe(canvas)

  watch(() => view.wireframe, () => {
    if (gridGroup) gridGroup.visible = gridVisible()
  })
  watch(() => view.grid, () => { if (gridGroup) gridGroup.visible = gridVisible() })

  let lastT = performance.now()
  requestAnimationFrame(function frame() {
    requestAnimationFrame(frame)
    const now = performance.now()
    const dt = (now - lastT) / 1000
    lastT = now
    resizeIfNeeded()
    if (!walkUpdate?.(dt)) controls.update()
    updateClips()
    updateGridLabels()
    for (const a of animators) a.update()
    scene.overrideMaterial = view.wireframe === "wire" ? wireMat : null
    renderer.render(scene, camera)
    if (view.wireframe === "overlay") {
      scene.overrideMaterial = wireMat
      const gv = gridGroup?.visible
      if (gridGroup) gridGroup.visible = false
      renderer.autoClear = false
      renderer.render(scene, camera)
      renderer.autoClear = true
      if (gridGroup) gridGroup.visible = gv
      scene.overrideMaterial = null
    }
    if (overlayScene.children.length) {
      renderer.autoClear = false
      renderer.render(overlayScene, camera)
      renderer.autoClear = true
    }
  })
}

let walkUpdate = null
const setWalkUpdate = fn => { walkUpdate = fn }

function setOrthoManual(on) {
  orthoManual = on
  setOrtho(on)
}

export function useScene() {
  return {
    view, scene, overlayScene, init, fit, setGrids, sceneBounds, setOrtho, setOrthoManual,
    makeHighlight,
    getGridRects: () => gridRects,
    contentRoots, animators, perspCam, FOV, updateProjection, setWalkUpdate, syncAspect,
    get camera() { return camera },
    get controls() { return controls },
    get canvas() { return canvas },
    get renderer() { return renderer }
  }
}
