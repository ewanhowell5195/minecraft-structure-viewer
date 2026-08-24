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
  out.userData.file = `textures/texture_${cache.size}.png`
  out.colorSpace = tex.colorSpace
  out.flipY = tex.flipY
  out.wrapS = tex.wrapS
  out.wrapT = tex.wrapT
  out.magFilter = out.minFilter = THREE.NearestFilter
  out.generateMipmaps = false
  cache.set(tex, out)
  return out
}

function portableMaterial(mat, caches) {
  let out = caches.mat.get(mat)
  if (out) return out
  const tex = matMap(mat)
  out = new THREE.MeshStandardMaterial({
    map: tex ? portableTexture(tex, caches.tex) : null,
    transparent: mat.transparent === true,
    alphaTest: mat.transparent ? 0 : 0.5,
    roughness: 1,
    metalness: 0,
    side: mat.side
  })
  out.name = `material_${caches.mat.size}`
  caches.mat.set(mat, out)
  return out
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
      const geo = new THREE.BufferGeometry()
      for (const [name, attr] of Object.entries(geometry.attributes)) geo.setAttribute(name, attr)
      geo.setIndex(new THREE.BufferAttribute(src.array.slice(g.start, g.start + g.count), 1))
      const mesh = new THREE.Mesh(geo, portableMaterial(m, caches))
      mesh.applyMatrix4(matrix)
      scene.add(mesh)
    }
    return
  }
  const conv = mats.map(m => portableMaterial(m, caches))
  const mesh = new THREE.Mesh(geometry, Array.isArray(o.material) ? conv : conv[0])
  mesh.applyMatrix4(matrix)
  scene.add(mesh)
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
    out.push(`newmtl ${mat.name}`, "Ka 0.000 0.000 0.000", "Kd 1.000 1.000 1.000", "Ks 0.000 0.000 0.000", "Ns 0")
    out.push(`illum ${mat.transparent ? 4 : 2}`)
    if (file) {
      out.push(`map_Kd ${file}`)
      // the atlas is a cutout: without this the leaves come out as solid squares
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
  const obj = `mtllib ${base}.mtl\n` + new OBJExporter().parse(scene)
  const materials = Array.from(caches.mat.values())
  const files = [
    { name: `${base}.obj`, data: encoder.encode(obj) },
    { name: `${base}.mtl`, data: encoder.encode(writeMtl(materials)) }
  ]
  for (const tex of caches.tex.values()) {
    files.push({ name: tex.userData.file, data: await pngBytes(tex.image) })
  }
  return makeZip(files)
}

export async function exportScene({ format, name, root }) {
  const scene = new THREE.Scene()
  const caches = { mat: new Map(), tex: new Map(), perGroup: format === "obj" }
  if (root) bakeGroup(scene, root, caches)
  if (!scene.children.length) return

  const base = name?.split("/").pop() || "structure"
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
