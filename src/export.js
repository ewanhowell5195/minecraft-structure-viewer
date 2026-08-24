import * as THREE from "three"
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js"
import { OBJExporter } from "three/addons/exporters/OBJExporter.js"
import { makeZip } from "./zip.js"

// shader materials and OffscreenCanvas atlas textures aren't portable, so
// everything is rebaked onto MeshStandardMaterial + real-canvas textures

const matMap = m => m.uniforms?.map?.value ?? m.map

function portableTexture(tex, cache) {
  let out = cache.get(tex)
  if (out) return out
  const img = tex.image
  const c = document.createElement("canvas")
  c.width = img.width
  c.height = img.height
  c.getContext("2d").drawImage(img, 0, 0)
  out = new THREE.CanvasTexture(c)
  out.userData.index = cache.size
  out.userData.file = `textures/atlas_${cache.size}.png`
  out.colorSpace = tex.colorSpace
  out.flipY = tex.flipY
  out.wrapS = tex.wrapS
  out.wrapT = tex.wrapT
  out.magFilter = out.minFilter = THREE.NearestFilter
  out.generateMipmaps = false
  cache.set(tex, out)
  return out
}

// obj identifies materials by name alone, so they have to be unique; past the
// atlas and how it blends there is nothing left to tell two of them apart
function uniqueName(want, taken) {
  let name = want
  for (let n = 2; taken.has(name); n++) name = `${want}_${n}`
  taken.add(name)
  return name
}

function portableMaterial(mat, caches) {
  let out = caches.mat.get(mat)
  if (out) return out
  const tex = matMap(mat)
  const map = tex ? portableTexture(tex, caches.tex) : null
  out = new THREE.MeshStandardMaterial({
    map,
    transparent: mat.transparent === true,
    alphaTest: mat.transparent ? 0 : 0.5,
    roughness: 1,
    metalness: 0,
    side: mat.side
  })
  const parts = [map ? `atlas_${map.userData.index}` : "untextured"]
  if (mat.transparent === true) parts.push("blend")
  if (mat.side === THREE.DoubleSide) parts.push("2s")
  out.name = uniqueName(parts.join("_"), caches.names)
  caches.mat.set(mat, out)
  return out
}

// grass, foliage and water carry their biome tint as vertex colors, which gltf
// keeps but obj has no notion of: there the tint becomes part of the material,
// so the faces are grouped by it and each group gets its own
function tintedMaterial(mat, key, caches) {
  const id = mat.name + ":" + key
  let out = caches.tint.get(id)
  if (out) return out
  const rgb = [key >> 16 & 255, key >> 8 & 255, key & 255].map(v => v / 255)
  out = mat.clone()
  out.name = `${mat.name}_tint_${key.toString(16).padStart(6, "0")}`
  out.userData.tint = rgb
  out.color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)
  caches.tint.set(id, out)
  return out
}

const WHITE = 0xFFFFFF

function withIndex(geometry, index) {
  const geo = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(geometry.attributes)) geo.setAttribute(name, attr)
  geo.setIndex(index)
  return geo
}

function addBaked(scene, geometry, material, matrix, caches) {
  const colors = caches.perGroup ? geometry.getAttribute("color") : null
  const index = geometry.index
  if (colors && index) {
    const rgb = colors.array
    const buckets = new Map()
    for (let i = 0; i < index.count; i += 3) {
      const v = index.getX(i)
      const key = rgb[v * 3] << 16 | rgb[v * 3 + 1] << 8 | rgb[v * 3 + 2]
      let list = buckets.get(key)
      if (!list) buckets.set(key, list = [])
      list.push(v, index.getX(i + 1), index.getX(i + 2))
    }
    if (buckets.size > 1 || !buckets.has(WHITE)) {
      for (const [key, list] of buckets) {
        const mesh = new THREE.Mesh(
          withIndex(geometry, new THREE.BufferAttribute(new Uint32Array(list), 1)),
          key === WHITE ? material : tintedMaterial(material, key, caches)
        )
        mesh.applyMatrix4(matrix)
        scene.add(mesh)
      }
      return
    }
  }
  const mesh = new THREE.Mesh(geometry, material)
  mesh.applyMatrix4(matrix)
  scene.add(mesh)
}

// exporters can't represent invisible material groups, so those meshes explode
// into one mesh per visible group. obj can't carry a multi-material mesh at all,
// only one usemtl per object, so there every group goes its own way
function bakeMesh(scene, o, matrix, caches, geometry = o.geometry) {
  const mats = [].concat(o.material)
  const groups = geometry.groups
  if (groups.length && ((caches.perGroup && mats.length > 1) || mats.some(m => m?.visible === false))) {
    const src = geometry.index
    for (const g of groups) {
      const m = mats[g.materialIndex]
      if (!m || m.visible === false) continue
      const geo = withIndex(geometry, new THREE.BufferAttribute(src.array.slice(g.start, g.start + g.count), 1))
      addBaked(scene, geo, portableMaterial(m, caches), matrix, caches)
    }
    return
  }
  const conv = mats.map(m => portableMaterial(m, caches))
  if (Array.isArray(o.material)) {
    const mesh = new THREE.Mesh(geometry, conv)
    mesh.applyMatrix4(matrix)
    scene.add(mesh)
    return
  }
  addBaked(scene, geometry, conv[0], matrix, caches)
}

// zero-scale instances are the hidden door state
const _inst = new THREE.Matrix4(), _instFull = new THREE.Matrix4()
function bakeGroup(scene, group, caches) {
  group.updateMatrixWorld(true)
  group.traverseVisible(o => {
    if (!o.isMesh) return
    if (o.isBatchedMesh) {
      for (const slot of o.userData.batchSlots ?? []) {
        o.getMatrixAt(slot.id, _inst)
        if (!_inst.elements[0] && !_inst.elements[5] && !_inst.elements[10]) continue
        bakeMesh(scene, o, _instFull.multiplyMatrices(o.matrixWorld, _inst), caches, slot.geometry)
      }
      return
    }
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, _inst)
        if (!_inst.elements[0] && !_inst.elements[5] && !_inst.elements[10]) continue
        bakeMesh(scene, o, _instFull.multiplyMatrices(o.matrixWorld, _inst), caches)
      }
      return
    }
    bakeMesh(scene, o, o.matrixWorld, caches)
  })
}

// obj keeps its materials in a sidecar file that points at the textures by
// path, so the three of them travel together in a zip
function writeMtl(materials) {
  const out = []
  for (const mat of materials) {
    const file = mat.map?.userData.file
    const [r, g, b] = mat.userData.tint ?? [1, 1, 1]
    out.push(
      `newmtl ${mat.name}`,
      "Ns 0.000",
      "Ka 0.000 0.000 0.000",
      `Kd ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`,
      "Ks 0.000 0.000 0.000",
      "Ni 1.000",
      "d 1.000",
      "illum 2"
    )
    if (file) {
      out.push(`map_Kd ${file}`)
      // the alpha rides in the atlas: without this the leaves come out as solid squares
      out.push(`map_d ${file}`)
    }
    out.push("")
  }
  return out.join("\n")
}

function pngBytes(canvas) {
  return new Promise(resolve => canvas.toBlob(async blob => resolve(new Uint8Array(await blob.arrayBuffer())), "image/png"))
}

async function objZip(scene, caches, base) {
  const encoder = new TextEncoder()
  // the obj exporter reads matrixWorld, which nothing has computed yet: without
  // this every mesh writes out at the origin, doors and all
  scene.updateMatrixWorld(true)
  const obj = `mtllib ${base}.mtl\n` + new OBJExporter().parse(scene)
  const materials = new Map()
  scene.traverse(o => {
    if (o.isMesh) for (const m of [].concat(o.material)) materials.set(m.name, m)
  })
  const files = [
    { name: `${base}.obj`, data: encoder.encode(obj) },
    { name: `${base}.mtl`, data: encoder.encode(writeMtl(materials.values())) }
  ]
  for (const tex of caches.tex.values()) {
    files.push({ name: tex.userData.file, data: await pngBytes(tex.image) })
  }
  return makeZip(files)
}

export async function exportScene({ format, name, root }) {
  // the viewer builds at 16 units a block; a block is a metre, which is what
  // gltf measures in, so the whole thing comes down to one unit a block
  const scene = new THREE.Group()
  scene.scale.setScalar(1 / 16)
  const caches = { mat: new Map(), tex: new Map(), tint: new Map(), names: new Set(), perGroup: format === "obj" }
  if (root) bakeGroup(scene, root, caches)
  if (!scene.children.length) return

  // a world selection is named "world · 16 chunks", which is no kind of filename
  const base = (name?.split("/").pop() ?? "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "structure"
  let blob, ext = format
  if (format === "glb") {
    const buf = await new GLTFExporter().parseAsync(scene, { binary: true })
    blob = new Blob([buf], { type: "model/gltf-binary" })
  } else {
    blob = await objZip(scene, caches, base)
    ext = "zip"
  }

  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `${base}.${ext}`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
