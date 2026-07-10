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
  wireframe: "off", // "off" | "wire" | "overlay"
  grid: true
})

let renderer = null, canvas = null
const scene = new THREE.Scene()
// near 2 (1/8 block): depth precision scales with the near plane, and 0.1
// left far surfaces quantising to the same depth value (distant z-fighting,
// faces poking through each other). walking can't get closer than ~4 units
// to a surface, so nothing visible ever clips
const perspCam = new THREE.PerspectiveCamera(FOV, 1, 2, 5000)
perspCam.position.set(-68, 50, -68)
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
const gridVisible = () => view.grid && view.wireframe !== "wire"
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

// north indicator: a vector "N" just past the north (-z) edge, drawn as
// lines so it stays crisp at any zoom. hidden once the camera is far enough
// that it would just be clutter
function makeNorth({ x, z, y, w, d }) {
  const nx = x + w * 8, x0 = nx - 2.5, x1 = nx + 2.5, zb = z - 3, zt = z - 9
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute([x0, y, zb, x0, y, zt, x0, y, zt, x1, y, zb, x1, y, zb, x1, y, zt], 3))
  const seg = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x62626a }))
  seg.userData = { at: new THREE.Vector3(nx, y, z - 6), showDist: 700 }
  return seg
}

// combination mode: the north marker's spot holds a floating nametag
// instead, fading in as the camera gets near that structure. the sprite
// stays hidden until the font has loaded and the texture is drawn
function makeNameTag({ x, z, y, w, d, label }) {
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true }))
  spr.visible = false
  spr.position.set(x + w * 8, y + 6, z - 6)
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

// block highlight: box edges whose lines invert whatever is behind them
// (1 - dst via custom blending) and always render on top; only the edges of
// camera-facing faces draw, so the back of the cube never shows through
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
  // corners are xyz bitmasks; faces are -x,+x,-y,+y,-z,+z. an edge draws
  // when either of its two adjacent faces looks at the camera: that keeps
  // the front + silhouette edges and drops the back ones
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

// proximity for the markers: ortho "zoom" moves no closer, so divide it out
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

// world-space xz extents of the current floor grids (walk mode spawns onto
// the nearest one when the camera is far away)
let gridRects = []

// rects: [{ x, z, y, w, d, label? }] with x/z/y in world units, w/d in blocks
function setGrids(rects) {
  gridRects = rects.map(r => ({ x0: r.x, z0: r.z, x1: r.x + r.w * 16, z1: r.z + r.d * 16 }))
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
    gridGroup.add(makeRectGrid(r))
    gridGroup.add(r.label ? makeNameTag(r) : makeNorth(r))
  }
  scene.add(gridGroup)
  refreshSphere()
}

const _bb = new THREE.Box3()
function sceneBounds() {
  _bb.makeEmpty()
  for (const r of contentRoots) _bb.expandByObject(r)
  if (_bb.isEmpty()) _bb.set(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8))
  return _bb
}

// the far plane follows the content: big combinations would otherwise get cut
// off by the fixed clip when zoomed out. the sphere is cached per build
// (setGrids fires once the meshes are in) and the clip tracks the camera
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
    resize()
    // while walking, the walk sim drives the camera instead of the orbit
    if (!walkUpdate?.(dt)) controls.update()
    updateClips()
    updateGridLabels()
    for (const a of animators) a.update()
    // overlay renders the scene twice: textures first, then the wireframe
    // over the same depth buffer, so hidden edges stay hidden
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
    makeHighlight,
    getGridRects: () => gridRects,
    contentRoots, animators, perspCam, FOV, updateProjection, setWalkUpdate,
    get camera() { return camera },
    get controls() { return controls },
    get canvas() { return canvas },
    get renderer() { return renderer }
  }
}
