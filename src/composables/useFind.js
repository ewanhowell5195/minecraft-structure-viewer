import { reactive, readonly, watch } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { setOverlay } from "./useHighlight.js"
import { useContainer } from "./useContainer.js"
import { usePacks } from "./usePacks.js"
import { useWalk } from "./useWalk.js"

const state = reactive({ on: false, index: 0, total: 0, label: "" })

const SHOWN = "rgba(255, 255, 255, 0.34)"
const CULLED = "rgba(255, 77, 77, 0.34)"

let list = []
let boxOf = null
let highlight = null
let moveRaf = 0
const _box = new THREE.Box3()
const _center = new THREE.Vector3()

const DIRS = [["north", 0, 0, -16], ["south", 0, 0, 16], ["west", -16, 0, 0], ["east", 16, 0, 0], ["up", 0, 16, 0], ["down", 0, -16, 0]]
const cullCache = new Map()
let tintToken = 0

function drawBox(faces) {
  setOverlay("find", [{
    boxes: [{ min: _box.min.toArray(), max: _box.max.toArray() }],
    faces: faces ?? {},
    colour: SHOWN,
    flash: true
  }])
}

// faces the build culled away pulse red, so a block you cannot actually see
// reads as buried instead of looking like one you just cannot spot
async function tint(item) {
  const token = ++tintToken
  if (!("state" in item)) return
  const build = useBuild()
  const s = build.current.value
  const root = build.getRoot()
  const assets = usePacks().assets.value
  if (!s || !root || !assets) return
  const wx = item.pos[0] * 16 + root.position.x
  const wy = item.pos[1] * 16 + root.position.y
  const wz = item.pos[2] * 16 + root.position.z
  const neighbors = {}
  const buried = []
  const key = [item.state]
  for (const [dir, dx, dy, dz] of DIRS) {
    const nb = build.blockEntryAt(wx + dx, wy + dy, wz + dz)
    if (nb?.buried) {
      buried.push(dir)
      key.push("b")
      continue
    }
    const ne = nb && s.palette[nb.state]
    key.push(ne ? nb.state : "")
    if (ne?.Name) neighbors[dir] = { id: ne.Name, ...(ne.Properties ?? {}) }
  }
  const cacheKey = key.join(",")
  let hidden = cullCache.get(cacheKey)
  if (!hidden) {
    const e = s.palette[item.state]
    try {
      const lib = await loadLibrary()
      const faces = await lib.getCullFaces({ id: e.Name, blockstates: e.Properties ?? {}, neighbors, assets })
      for (const dir of buried) faces.add(dir)
      hidden = faces
    } catch { hidden = new Set() }
    cullCache.set(cacheKey, hidden)
  }
  if (token !== tintToken || !hidden.size) return
  drawBox(Object.fromEntries(Array.from(hidden, dir => [dir, CULLED])))
}

// the hover outline owns the block under the cursor while it is clickable, so
// the pulse steps aside rather than fighting it
function setShown(on) {
  if (!state.on) return
  on ? highlight.show(_box) : highlight.hide()
  on ? drawBox() : setOverlay("find", [])
}

function paint() {
  const item = list[state.index]
  const box = item && boxOf(item)
  if (!box) return stop()
  _box.copy(box)
  _box.getCenter(_center)
  highlight ??= useScene().makeHighlight()
  setShown(!useContainer().state.hovering)
  tint(item)
}

function focus() {
  const { camera, controls } = useScene()
  if (!camera || !controls) return
  const from = camera.position.clone(), fromTarget = controls.target.clone()
  const dir = from.clone().sub(fromTarget)
  if (dir.lengthSq() < 1e-6) dir.set(-34, 25, -34)
  const dist = Math.min(Math.max(dir.length(), 40), 160)
  const to = _center.clone().addScaledVector(dir.normalize(), dist)
  const start = performance.now()
  cancelAnimationFrame(moveRaf)
  const step = () => {
    const k = Math.min((performance.now() - start) / 260, 1)
    const e = 1 - (1 - k) ** 3
    camera.position.lerpVectors(from, to, e)
    controls.target.lerpVectors(fromTarget, _center, e)
    controls.update()
    if (k < 1) moveRaf = requestAnimationFrame(step)
  }
  step()
}

function show() {
  paint()
  focus()
}

// a multi-structure load walks one structure at a time, not one y level across
// all of them, so the piece a block sits in leads the ordering
function partIndexer() {
  const parts = useBuild().current.value?.__parts
  if (!parts?.length) return () => 0
  return pos => {
    for (let i = 0; i < parts.length; i++) {
      const { off, size } = parts[i]
      if (pos[0] >= off[0] && pos[0] < off[0] + size[0]
        && pos[1] >= off[1] && pos[1] < off[1] + size[1]
        && pos[2] >= off[2] && pos[2] < off[2] + size[2]) return i
    }
    return parts.length
  }
}

function start(items, label, resolve) {
  const found = items?.filter(i => resolve(i)) ?? []
  if (!found.length) return
  boxOf = resolve
  const indexOf = partIndexer()
  const part = new Map(found.map(i => [i, indexOf(i.pos)]))
  list = found.sort((a, b) =>
    part.get(a) - part.get(b) || a.pos[1] - b.pos[1] || a.pos[2] - b.pos[2] || a.pos[0] - b.pos[0])
  state.on = true
  state.total = list.length
  state.index = 0
  state.label = label
  show()
}

function go(step) {
  if (!state.on) return
  state.index = (state.index + step % state.total + state.total) % state.total
  show()
}

function stop() {
  if (!state.on) return
  state.on = false
  list = []
  state.total = 0
  state.index = 0
  cullCache.clear()
  cancelAnimationFrame(moveRaf)
  highlight?.hide()
  setOverlay("find", [])
}

watch(() => useContainer().state.hovering, on => setShown(!on))
watch(() => useBuild().current.value, stop)
watch(() => useWalk().state.on, on => { if (on) stop() })

export function useFind() {
  return { state: readonly(state), start, go, stop }
}
