import * as THREE from "three"

// helpers shared by the stream main thread, the stream workers, and the door
// module; each context gets its own module instance, so the caches are
// per-context by construction
export const isPlane = el => el?.from && (el.from[0] === el.to[0] || el.from[1] === el.to[1] || el.from[2] === el.to[2])

// blocks the lib loads as dynamic models (live part rigs, pose methods); their
// rigs can't survive pack/revive, so streamed tiles exclude them from baked
// geometry and build them live on the main thread
export const DYNAMIC_BLOCKS = /(^|:)([a-z_]+_)?(banner|bell|chest|shulker_box|decorated_pot|enchanting_table|dragon_head|dragon_wall_head|piglin_head|piglin_wall_head)$/

// vanilla collision overrides the all-planes rule gets wrong: torches are 3D
// but walkable, chains are crossed planes but block you
export const SOFT_BLOCKS = /(^|[:_])torch$/
export const HARD_BLOCKS = /(^|[:_])chain$/

// state key -> Promise<bool>: true when every element is an axis plane, so
// walk treats the block as soft (no collision)
const softCache = new Map()
export function softFor(lib, assets, entry) {
  const k = entry.id + "|" + JSON.stringify(entry.properties ?? null)
  let p = softCache.get(k)
  if (!p) {
    p = (async () => {
      if (SOFT_BLOCKS.test(entry.id)) return true
      if (HARD_BLOCKS.test(entry.id)) return false
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

export function rayBoxT(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
  let tmin = 0, tmax = Infinity
  for (const [o, d, a, b] of [[ox, dx, x0, x1], [oy, dy, y0, y1], [oz, dz, z0, z1]]) {
    if (Math.abs(d) < 1e-9) {
      if (o < a || o > b) return null
    } else {
      let t1 = (a - o) / d, t2 = (b - o) / d
      if (t1 > t2) [t1, t2] = [t2, t1]
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) return null
    }
  }
  return tmin
}

// the bell body's two cubes (vanilla BELL_SHAPE), in block-local px
const BELL_CUBES = [[5, 6, 5, 11, 13, 11], [4, 4, 4, 12, 6, 12]]

// which way a click at this ray rings a bell. Primary faces keep the face you
// hit (a floor bell's two outer faces along its facing axis, every side when
// hung); anything else (top, bottom, a floor bell's blocked sides) swings away
// from the view, with floor bells still pinned to their facing axis
export function bellRingDir(ox, oy, oz, dx, dy, dz, bx, by, bz, props) {
  let best = null
  for (const c of BELL_CUBES) {
    const t = rayBoxT(ox, oy, oz, dx, dy, dz, bx + c[0], by + c[1], bz + c[2], bx + c[3], by + c[4], bz + c[5])
    if (t != null && (!best || t < best.t)) best = { t, c }
  }
  if (!best) return null
  const hx = ox + dx * best.t, hz = oz + dz * best.t
  const [x0, , z0, x1, , z1] = best.c
  const eps = 1e-3
  const face = Math.abs(hx - (bx + x0)) < eps ? "west"
    : Math.abs(hx - (bx + x1)) < eps ? "east"
    : Math.abs(hz - (bz + z0)) < eps ? "north"
    : Math.abs(hz - (bz + z1)) < eps ? "south"
    : null
  const floor = (props.attachment ?? "floor") === "floor"
  const swingsZ = !(props.facing === "east" || props.facing === "west")
  if (face) {
    const faceZ = face === "north" || face === "south"
    if (!floor || faceZ === swingsZ) return face
  }
  if (floor) return swingsZ ? (dz >= 0 ? "north" : "south") : (dx >= 0 ? "west" : "east")
  return Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? "west" : "east") : (dz >= 0 ? "north" : "south")
}

const _cb = new THREE.Box3()
export function templateBoxes(tmpl) {
  const arr = []
  const skip = o => {
    for (let n = o; n && n !== tmpl; n = n.parent) {
      if (n.userData?.model?.fluid || n.userData?.dynamic === "enchanting_book") return true
    }
    return false
  }
  tmpl.updateMatrixWorld(true)
  tmpl.traverse(o => {
    const coll = o.userData.collision
    if (coll) {
      if (skip(o)) return
      for (const c of coll) {
        _cb.min.set(c[0], c[1], c[2])
        _cb.max.set(c[3], c[4], c[5])
        _cb.applyMatrix4(o.matrixWorld)
        if (!_cb.isEmpty()) arr.push([_cb.min.x, _cb.min.y, _cb.min.z, _cb.max.x, _cb.max.y, _cb.max.z])
      }
      return
    }
    if (!o.isMesh || o.parent?.userData.collision) return
    if (skip(o)) return
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
