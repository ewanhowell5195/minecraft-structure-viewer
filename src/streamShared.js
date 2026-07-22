import * as THREE from "three"

// helpers shared by the stream main thread, the stream workers, and the door
// module; each context gets its own module instance, so the caches are
// per-context by construction
export const isPlane = el => el?.from && (el.from[0] === el.to[0] || el.from[1] === el.to[1] || el.from[2] === el.to[2])

// blocks the lib loads as dynamic models (live part rigs, pose methods); their
// rigs can't survive pack/revive, so streamed tiles exclude them from baked
// geometry and build them live on the main thread
export const DYNAMIC_BLOCKS = /(^|:)([a-z_]+_)?(banner|bell|chest|shulker_box|decorated_pot|enchanting_table|dragon_head|dragon_wall_head|piglin_head|piglin_wall_head)$/

// state key -> Promise<bool>: true when every element is an axis plane, so
// walk treats the block as soft (no collision)
const softCache = new Map()
export function softFor(lib, assets, entry) {
  const k = entry.id + "|" + JSON.stringify(entry.properties ?? null)
  let p = softCache.get(k)
  if (!p) {
    p = (async () => {
      let any = false, allPlanes = true
      for (const model of entry.models ?? []) {
        if (model?.fluid) continue
        const data = await lib.resolveModelData(assets, model)
        for (const el of data?.elements ?? []) { any = true; if (!isPlane(el)) allPlanes = false }
      }
      return any && allPlanes
    })().catch(() => false)
    softCache.set(k, p)
  }
  return p
}

const solidCache = new Map()
export function solidFor(lib, assets, id, properties) {
  const k = id + "|" + JSON.stringify(properties ?? null)
  let p = solidCache.get(k)
  if (!p) {
    p = Promise.resolve(lib.fullyOccludes?.({ id, properties, assets })).then(v => v ?? false).catch(() => false)
    solidCache.set(k, p)
  }
  return p
}

const _cb = new THREE.Box3()
export function templateBoxes(tmpl) {
  const arr = []
  const inFluid = o => {
    for (let n = o; n && n !== tmpl; n = n.parent) if (n.userData?.model?.fluid) return true
    return false
  }
  tmpl.updateMatrixWorld(true)
  tmpl.traverse(o => {
    const coll = o.userData.collision
    if (coll) {
      if (inFluid(o)) return
      for (const c of coll) {
        _cb.min.set(c[0], c[1], c[2])
        _cb.max.set(c[3], c[4], c[5])
        _cb.applyMatrix4(o.matrixWorld)
        if (!_cb.isEmpty()) arr.push([_cb.min.x, _cb.min.y, _cb.min.z, _cb.max.x, _cb.max.y, _cb.max.z])
      }
      return
    }
    if (!o.isMesh || o.parent?.userData.collision) return
    if (inFluid(o)) return
    _cb.setFromObject(o)
    if (!_cb.isEmpty()) arr.push([_cb.min.x, _cb.min.y, _cb.min.z, _cb.max.x, _cb.max.y, _cb.max.z])
  })
  return arr
}

// clone a lib shader material sharing its uniform ENTRIES: three's clone
// would deep-copy uniform textures, uploading duplicates per clone
export function cloneShaderShared(m) {
  const u = m.uniforms
  if (u) m.uniforms = {}
  const c = m.clone()
  if (u) {
    m.uniforms = u
    c.uniforms = { ...u }
  }
  return c
}
