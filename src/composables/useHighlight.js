import { watch } from "vue"
import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"

const PERIOD = 1200
// how far a flashing shape dims at the bottom of its cycle
const FLOOR = 0.2

// each caller owns a layer, so the embed API and the block finder can both
// have shapes up without clearing each other
const layers = new Map()
let drawn = []
let raf = 0
let probe = null

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _size = new THREE.Vector3()
const _matrix = new THREE.Matrix4()

// canvas fillStyle normalises any css colour to #rrggbb or rgba(), which is the
// shortest route to a three colour plus the alpha the caller asked for
function parseColour(css) {
  if (!CSS.supports("color", css)) throw new Error(`unknown colour: ${css}`)
  probe ??= document.createElement("canvas").getContext("2d")
  probe.fillStyle = css
  const value = probe.fillStyle
  if (value.startsWith("#")) return { colour: value, alpha: 1 }
  const parts = value.slice(value.indexOf("(") + 1, -1).split(",").map(parseFloat)
  return { colour: `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`, alpha: parts[3] ?? 1 }
}

function clear() {
  const scene = useScene().scene
  for (const d of drawn) {
    scene.remove(d.object)
    d.object.geometry.dispose()
    for (const m of [].concat(d.object.material)) m.dispose()
    d.object.dispose?.()
  }
  drawn = []
  cancelAnimationFrame(raf)
  raf = 0
}

function pulse() {
  raf = requestAnimationFrame(pulse)
  const k = (1 - Math.cos(performance.now() / PERIOD * Math.PI * 2)) / 2
  for (const d of drawn) {
    if (!d.flash) continue
    for (const m of [].concat(d.object.material)) m.opacity = m.userData.alpha * (FLOOR + (1 - FLOOR) * k)
  }
}

// the 12 edges of a block, as corner offsets from its centre
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7]
]

// each face as its normal and its four corners wound anticlockwise from
// outside, in the order BoxGeometry groups them so per-face colours line up
const FACES = [
  { dir: "east", n: [1, 0, 0], corners: [[8, -8, 8], [8, -8, -8], [8, 8, -8], [8, 8, 8]] },
  { dir: "west", n: [-1, 0, 0], corners: [[-8, -8, -8], [-8, -8, 8], [-8, 8, 8], [-8, 8, -8]] },
  { dir: "up", n: [0, 1, 0], corners: [[-8, 8, 8], [8, 8, 8], [8, 8, -8], [-8, 8, -8]] },
  { dir: "down", n: [0, -1, 0], corners: [[-8, -8, -8], [8, -8, -8], [8, -8, 8], [-8, -8, 8]] },
  { dir: "south", n: [0, 0, 1], corners: [[-8, -8, 8], [8, -8, 8], [8, 8, 8], [-8, 8, 8]] },
  { dir: "north", n: [0, 0, -1], corners: [[8, -8, -8], [-8, -8, -8], [-8, 8, -8], [8, 8, -8]] }
]

const key3 = (x, y, z) => `${x},${y},${z}`

function geometryOf(points) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3))
  return geo
}

// the face carries on flat into its neighbour, so nothing of the shell ends here
const carriesOn = (p, n, t, has) =>
  has(p[0] + t[0], p[1] + t[1], p[2] + t[2]) &&
  !has(p[0] + t[0] + n[0], p[1] + t[1] + n[1], p[2] + t[2] + n[2])

// growing a face along its normal alone would leave a seam where it meets the
// face round the corner, so it grows sideways too wherever the shell ends
function cornerAt(p, face, corner, origin, has, grow) {
  const out = [0, 0, 0]
  const t = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    let offset = corner[a] + face.n[a] * grow
    if (!face.n[a]) {
      t[0] = t[1] = t[2] = 0
      t[a] = Math.sign(corner[a])
      if (!carriesOn(p, face.n, t, has)) offset += t[a] * grow
    }
    out[a] = origin[a] + offset
  }
  return out
}

// only faces with nothing of the same style behind them, so touching blocks
// read as one shell instead of stacked boxes
function mergedFill(cells, root, has, grow) {
  const out = []
  const origin = [0, 0, 0]
  for (const p of cells) {
    origin[0] = p[0] * 16 + root.position.x
    origin[1] = p[1] * 16 + root.position.y
    origin[2] = p[2] * 16 + root.position.z
    for (const face of FACES) {
      if (has(p[0] + face.n[0], p[1] + face.n[1], p[2] + face.n[2])) continue
      const [a, b, c, d] = face.corners
      for (const corner of [a, b, c, a, c, d]) {
        out.push(...cornerAt(p, face, corner, origin, has, grow))
      }
    }
  }
  return geometryOf(out)
}

// an edge survives only where the shell stops or turns: if the neighbour along
// the edge carries the same face, the two are coplanar and the line is internal
function mergedEdges(cells, root, has, grow) {
  const out = []
  const seen = new Set()
  const origin = [0, 0, 0]
  for (const p of cells) {
    origin[0] = p[0] * 16 + root.position.x
    origin[1] = p[1] * 16 + root.position.y
    origin[2] = p[2] * 16 + root.position.z
    for (const face of FACES) {
      if (has(p[0] + face.n[0], p[1] + face.n[1], p[2] + face.n[2])) continue
      for (let i = 0; i < 4; i++) {
        const c1 = face.corners[i], c2 = face.corners[(i + 1) % 4]
        // the axis this edge sits on, away from the face centre
        const t = [0, 1, 2].map(a => face.n[a] ? 0 : Math.sign(c1[a] + c2[a]))
        if (carriesOn(p, face.n, t, has)) continue
        const p1 = cornerAt(p, face, c1, origin, has, grow)
        const p2 = cornerAt(p, face, c2, origin, has, grow)
        const id = [key3(...p1), key3(...p2)].sort().join("|")
        if (seen.has(id)) continue
        seen.add(id)
        out.push(...p1, ...p2)
      }
    }
  }
  return geometryOf(out)
}

function boxEdges(boxes, grow) {
  const out = new Float32Array(boxes.length * EDGES.length * 6)
  let n = 0
  for (const b of boxes) {
    for (const edge of EDGES) {
      for (const corner of edge) {
        out[n++] = (corner & 1 ? b.max[0] + grow : b.min[0] - grow)
        out[n++] = (corner & 2 ? b.max[1] + grow : b.min[1] - grow)
        out[n++] = (corner & 4 ? b.max[2] + grow : b.min[2] - grow)
      }
    }
  }
  return geometryOf(out)
}

function fillMaterial({ colour, alpha }, front) {
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colour),
    transparent: true,
    opacity: alpha,
    depthTest: !front,
    depthWrite: false
  })
  material.userData.alpha = alpha
  return material
}

// world coordinates for a group's blocks, so cells and explicit boxes draw
// through the same instanced path
function boxesOf(group, root) {
  if (group.boxes) return group.boxes
  return group.cells.map(p => ({
    min: [p[0] * 16 + root.position.x - 8, p[1] * 16 + root.position.y - 8, p[2] * 16 + root.position.z - 8],
    max: [p[0] * 16 + root.position.x + 8, p[1] * 16 + root.position.y + 8, p[2] * 16 + root.position.z + 8]
  }))
}

function draw(group, root, scene) {
  const cells = group.cells ?? []
  const set = new Set(cells.map(p => key3(...p)))
  const has = (x, y, z) => set.has(key3(x, y, z))
  // sitting in the world means sharing a plane with the block's own faces, so
  // the shape grows a hair to keep it off them
  const grow = group.front ? 0 : 0.06
  const merge = group.merge && !group.boxes && !group.faces

  if (group.fill || group.faces) {
    let mesh
    if (merge) {
      mesh = new THREE.Mesh(mergedFill(cells, root, has, grow), fillMaterial(group.fill, group.front))
    } else {
      const material = group.faces
        ? FACES.map(f => fillMaterial(group.faces[f.dir] ?? group.fill, group.front))
        : fillMaterial(group.fill, group.front)
      const boxes = boxesOf(group, root)
      mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, boxes.length)
      boxes.forEach((b, i) => {
        _pos.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2)
        _size.set(b.max[0] - b.min[0] + grow * 2, b.max[1] - b.min[1] + grow * 2, b.max[2] - b.min[2] + grow * 2)
        _matrix.compose(_pos, _quat, _size)
        mesh.setMatrixAt(i, _matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
    }
    mesh.frustumCulled = false
    mesh.renderOrder = group.front ? 997 : 0
    scene.add(mesh)
    drawn.push({ object: mesh, flash: group.flash })
  }

  if (group.line) {
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(group.line.colour),
      transparent: true,
      opacity: group.line.alpha,
      depthTest: !group.front,
      depthWrite: false
    })
    material.userData.alpha = group.line.alpha
    const lines = new THREE.LineSegments(
      merge ? mergedEdges(cells, root, has, grow) : boxEdges(boxesOf(group, root), grow),
      material
    )
    lines.frustumCulled = false
    lines.renderOrder = group.front ? 998 : 1
    scene.add(lines)
    drawn.push({ object: lines, flash: group.flash })
  }
}

function build() {
  clear()
  const root = useBuild().getRoot()
  if (!root) return
  const scene = useScene().scene
  for (const groups of layers.values()) {
    // one shape per style, so touching blocks can merge and colours never mix
    const byStyle = new Map()
    for (const g of groups) {
      if (g.boxes) {
        draw(g, root, scene)
        continue
      }
      const key = JSON.stringify([g.fill, g.faces, g.line, g.flash, g.merge, g.front])
      let merged = byStyle.get(key)
      if (!merged) byStyle.set(key, merged = { ...g, cells: [] })
      merged.cells.push(...g.cells)
    }
    for (const g of byStyle.values()) draw(g, root, scene)
  }
  if (drawn.some(d => d.flash)) pulse()
}

const isCoord = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)

function parseGroups(input) {
  if (input == null) return []
  if (!Array.isArray(input)) throw new Error("highlight needs an array of groups")
  return input.map((group, i) => {
    if (!Array.isArray(group?.blocks)) throw new Error(`group ${i} needs a blocks array of [x, y, z] coords`)
    const cells = isCoord(group.blocks) ? [group.blocks] : group.blocks
    for (const pos of cells) {
      if (!isCoord(pos)) throw new Error(`group ${i} has a block that is not [x, y, z]`)
    }
    const fill = group.colour ?? group.color
    const line = group.wireframe
    return {
      cells: cells.map(pos => pos.map(Math.floor)),
      flash: group.flash === true,
      merge: group.merge !== false,
      front: group.front !== false,
      // a group asking only for a wireframe gets no fill behind it
      fill: fill || !line ? parseColour(fill ?? "#ffffff99") : null,
      line: line ? parseColour(line) : null
    }
  })
}

export function setHighlights(input) {
  const groups = parseGroups(input)
  layers.set("api", groups)
  build()
  return groups.reduce((n, g) => n + g.cells.length, 0)
}

// for the app's own overlays: takes parsed colours and world boxes rather than
// the embed API's css and block coords
export function setOverlay(name, groups) {
  layers.set(name, groups.map(g => ({
    flash: false,
    merge: true,
    front: true,
    fill: null,
    line: null,
    ...g,
    ...(g.faces ? { faces: Object.fromEntries(Object.entries(g.faces).map(([dir, c]) => [dir, parseColour(c)])) } : {}),
    ...(g.colour ? { fill: parseColour(g.colour) } : {})
  })))
  build()
}

// current changes as a build starts, when the root is about to be torn down;
// info lands with the finished scene, which is the root these sit against
watch(() => [useBuild().current.value, useBuild().state.info], build)
