import * as THREE from "three"

// interactive doors for streamed tiles: door blocks are excluded from tile
// geometry by the worker and shipped as a list; this module grows a global
// cache of canonical door templates (rotation folded per instance, like the
// orbit build's door system) and gives each tile its own instanced meshes so
// materials carry that tile's light volume. Toggling swaps open/closed
// instance slots exactly like orbit's setDoorInstance.
export const OPENABLE = /(^|:)([a-z_]+_)?(door|trapdoor|fence_gate)$/

const PANEL = {
  north: [0, 0, 13, 16, 16, 16],
  south: [0, 0, 0, 16, 16, 3],
  east: [0, 0, 0, 3, 16, 16],
  west: [13, 0, 0, 16, 16, 16],
  up: [0, 0, 0, 16, 3, 16],
  down: [0, 13, 0, 16, 16, 16]
}
const CW = { north: "east", east: "south", south: "west", west: "north" }
const CCW = { north: "west", west: "south", south: "east", east: "north" }

export function doorShape(id, p = {}) {
  const name = (id || "").replace(/^minecraft:/, "")
  if (/fence_gate$/.test(name)) {
    const tall = p.in_wall === "true" ? 13 : 16
    return p.facing === "north" || p.facing === "south" ? [0, 0, 6, 16, tall, 10] : [6, 0, 0, 10, tall, 16]
  }
  if (/trapdoor$/.test(name)) {
    if (p.open === "true") return PANEL[p.facing] ?? PANEL.north
    return p.half === "top" ? PANEL.down : PANEL.up
  }
  if (/door$/.test(name)) {
    const dir = p.open === "true" ? (p.hinge === "right" ? CCW[p.facing] : CW[p.facing]) : p.facing
    return PANEL[dir] ?? PANEL.north
  }
  return [0, 0, 0, 16, 16, 16]
}

function mergeInstanceSource(geometry, material) {
  const mats = [].concat(material)
  if (!geometry.index || !geometry.groups?.length || mats.length < 2) return { geometry, material }
  const keep = new Map()
  for (const g of geometry.groups) {
    const m = mats[g.materialIndex] ?? mats[0]
    if (!m || m.visible === false) continue
    let list = keep.get(m)
    if (!list) keep.set(m, list = [])
    list.push(g)
  }
  if (!keep.size) return null
  const src = geometry.index.array
  let total = 0
  for (const list of keep.values()) for (const g of list) total += Math.min(g.count, src.length - g.start)
  const index = new src.constructor(total)
  const geo = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(geometry.attributes)) geo.setAttribute(name, attr)
  let offset = 0
  const materials = []
  for (const [m, list] of keep) {
    const start = offset
    for (const g of list) {
      const count = Math.min(g.count, src.length - g.start)
      index.set(src.subarray(g.start, g.start + count), offset)
      offset += count
    }
    if (keep.size > 1) geo.addGroup(start, offset - start, materials.length)
    materials.push(m)
  }
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  return { geometry: geo, material: materials.length > 1 ? materials : materials[0] }
}

const stateKeyOf = (id, props) => id + "|" + JSON.stringify(props ?? null)

// stateKey -> { key, rot } and canon key -> { parts: [{geometry, material, base}] } | null
const stateInfo = new Map()
const canonParts = new Map()
const boxCache = new Map()

const _dm = new THREE.Matrix4()
const _dzero = new THREE.Matrix4().makeScale(0, 0, 0)
const _cb = new THREE.Box3()

function templateBoxes(tmpl) {
  const arr = []
  tmpl.updateMatrixWorld(true)
  tmpl.traverse(o => {
    const coll = o.userData.collision
    if (coll) {
      for (const c of coll) {
        _cb.min.set(c[0], c[1], c[2])
        _cb.max.set(c[3], c[4], c[5])
        _cb.applyMatrix4(o.matrixWorld)
        if (!_cb.isEmpty()) arr.push([_cb.min.x, _cb.min.y, _cb.min.z, _cb.max.x, _cb.max.y, _cb.max.z])
      }
      return
    }
    if (!o.isMesh || o.parent?.userData.collision) return
    _cb.setFromObject(o)
    if (!_cb.isEmpty()) arr.push([_cb.min.x, _cb.min.y, _cb.min.z, _cb.max.x, _cb.max.y, _cb.max.z])
  })
  return arr
}

async function canonOf(lib, assets, id, props) {
  const models = await lib.parseBlockstate(assets, id, { data: props ?? {}, ignoreAtlases: true })
  const m = models.length === 1 ? models[0] : null
  if (m && !(m.uvlock && (m.x || m.y || m.z))) {
    const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(-(m.x ?? 0)),
      THREE.MathUtils.degToRad(-(m.y ?? 0)),
      THREE.MathUtils.degToRad(m.z ?? 0), "ZYX"))
    return { key: JSON.stringify({ ...m, x: 0, y: 0, z: 0 }), rot, build: [{ ...m, x: 0, y: 0, z: 0 }] }
  }
  return { key: "state:" + stateKeyOf(id, props), rot: new THREE.Matrix4(), build: models }
}

async function buildCanonGroup(lib, assets, modelList) {
  const g = new THREE.Group()
  for (const model of modelList) {
    const data = await lib.resolveModelData(assets, model)
    await lib.loadModel(g, assets, data, { display: {}, lighting: "world", animate: false })
  }
  return g.children.length ? g : null
}

function extractParts(tmplGroup) {
  tmplGroup.updateMatrixWorld(true)
  const parts = []
  tmplGroup.traverse(o => {
    if (!o.isMesh) return
    const merged = mergeInstanceSource(o.geometry, o.material)
    if (merged) parts.push({ geometry: merged.geometry, material: merged.material, base: o.matrixWorld.clone() })
  })
  return parts.length ? parts : null
}

async function ensureState(lib, assets, id, props) {
  const sk = stateKeyOf(id, props)
  let info = stateInfo.get(sk)
  if (info) return info
  let key = null
  let rot = new THREE.Matrix4()
  try {
    const canon = await canonOf(lib, assets, id, props)
    key = canon.key
    rot = canon.rot
    if (!canonParts.has(key)) {
      const tmplGroup = await buildCanonGroup(lib, assets, canon.build)
      let parts = null
      if (tmplGroup) {
        parts = extractParts(tmplGroup)
        if (parts) boxCache.set(key, templateBoxes(tmplGroup))
      }
      canonParts.set(key, parts)
    }
  } catch { key = null }
  info = { key, rot, sk }
  stateInfo.set(sk, info)
  return info
}

// worker side: build canonical templates for door states this worker hasn't
// shipped yet and pack them as transferable geometry + material specs, so the
// main thread never runs the model pipeline for doors mid-flight
export async function packDoorTemplates(lib, assets, doors, shippedStates, shippedKeys) {
  const states = [], templates = [], transfers = []
  const bitmapIdx = new Map()
  const bitmaps = []
  for (const d of doors) {
    for (const open of ["true", "false"]) {
      const props = { ...(d.properties ?? {}), open }
      const sk = stateKeyOf(d.id, props)
      if (shippedStates.has(sk)) continue
      shippedStates.add(sk)
      try {
        const canon = await canonOf(lib, assets, d.id, props)
        states.push({ sk, key: canon.key, rot: canon.rot.elements.slice() })
        if (shippedKeys.has(canon.key)) continue
        shippedKeys.add(canon.key)
        const tmplGroup = await buildCanonGroup(lib, assets, canon.build)
        const parts = tmplGroup && extractParts(tmplGroup)
        if (!parts) { templates.push({ key: canon.key, parts: null }); continue }
        const packedParts = []
        for (const p of parts) {
          const geo = p.geometry
          const attrs = {}
          for (const [name, a] of Object.entries(geo.attributes)) {
            const arr = a.array.slice()
            attrs[name] = { array: arr, itemSize: a.itemSize, normalized: a.normalized }
            transfers.push(arr.buffer)
          }
          let index = null
          if (geo.index) {
            index = geo.index.array.slice()
            transfers.push(index.buffer)
          }
          const materials = []
          for (const m of [].concat(p.material)) {
            const u = m.uniforms ?? {}
            const tex = u.map?.value ?? m.map ?? null
            let ti = null
            if (tex?.image) {
              ti = bitmapIdx.get(tex)
              if (ti === undefined) {
                const bmp = await createImageBitmap(tex.image)
                ti = bitmaps.length
                bitmaps.push(bmp)
                transfers.push(bmp)
                bitmapIdx.set(tex, ti)
              }
            }
            materials.push({
              tex: ti,
              colorSpace: tex?.colorSpace ?? null,
              emission: u.emission?.value ?? 0,
              shadeEnabled: u.shadeEnabled?.value !== false,
              shadeOverride: u.shadeOverride?.value ? u.shadeOverride.value.toArray() : [0, 0, 0],
              aoEnabled: u.aoEnabled?.value !== false,
              side: m.side,
              transparent: m.transparent,
              depthWrite: m.depthWrite
            })
          }
          packedParts.push({
            base: p.base.elements.slice(),
            attrs, index,
            groups: geo.groups?.length ? geo.groups.map(g => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })) : null,
            materials
          })
        }
        templates.push({ key: canon.key, parts: packedParts, boxes: boxCache.get(canon.key) ?? templateBoxes(tmplGroup) })
      } catch {}
    }
  }
  if (!states.length && !templates.length) return null
  return { pack: { states, templates, bitmaps }, transfers }
}

// main side: revive shipped templates into the global canon cache. baseMat is
// any lib world-lighting material from the tile; per-tile light rebinding
// still happens in cloneMaterialFor
export function importDoorTemplates(pack, baseMat) {
  if (!pack) return
  const textures = []
  const textureFor = i => {
    if (i == null) return null
    if (textures[i]) return textures[i]
    const bmp = pack.bitmaps[i]
    if (!bmp) return null
    const canvas = document.createElement("canvas")
    canvas.width = bmp.width
    canvas.height = bmp.height
    canvas.getContext("2d").drawImage(bmp, 0, 0)
    bmp.close?.()
    const tex = new THREE.Texture(canvas)
    tex.magFilter = tex.minFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    tex.needsUpdate = true
    return textures[i] = tex
  }
  for (const t of pack.templates ?? []) {
    if (canonParts.has(t.key)) continue
    if (!t.parts) { canonParts.set(t.key, null); continue }
    if (!baseMat?.uniforms) continue
    const parts = []
    for (const p of t.parts) {
      const geo = new THREE.BufferGeometry()
      for (const [name, a] of Object.entries(p.attrs)) geo.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized))
      if (p.index) geo.setIndex(new THREE.BufferAttribute(p.index, 1))
      if (p.groups) for (const g of p.groups) geo.addGroup(g.start, g.count, g.materialIndex)
      const mats = p.materials.map(spec => {
        const tex = textureFor(spec.tex)
        if (tex && spec.colorSpace != null) tex.colorSpace = spec.colorSpace
        const u = baseMat.uniforms
        baseMat.uniforms = {}
        const c = baseMat.clone()
        baseMat.uniforms = u
        c.uniforms = { ...u }
        c.uniforms.map = { value: tex }
        c.uniforms.emission = { value: spec.emission }
        c.uniforms.shadeEnabled = { value: spec.shadeEnabled }
        c.uniforms.shadeOverride = { value: new THREE.Vector3(...spec.shadeOverride) }
        c.uniforms.aoEnabled = { value: spec.aoEnabled }
        c.defines = { ...c.defines }
        delete c.defines.FACE_ATTRS
        c.side = spec.side
        c.transparent = spec.transparent
        c.depthWrite = spec.depthWrite
        return c
      })
      parts.push({ geometry: geo, material: mats.length > 1 ? mats : mats[0], base: new THREE.Matrix4().fromArray(p.base) })
    }
    canonParts.set(t.key, parts.length ? parts : null)
    if (t.boxes) boxCache.set(t.key, t.boxes)
  }
  for (const s of pack.states ?? []) {
    if (!stateInfo.has(s.sk)) stateInfo.set(s.sk, { key: s.key, rot: new THREE.Matrix4().fromArray(s.rot), sk: s.sk })
  }
}

function cloneMaterialFor(mat, lightMat) {
  const out = (Array.isArray(mat) ? mat : [mat]).map(m => {
    const u = m.uniforms
    if (u) m.uniforms = {}
    const c = m.clone()
    if (u) {
      m.uniforms = u
      // share entries: three's clone would deep-copy uniform textures,
      // uploading duplicates per tile
      c.uniforms = { ...u }
    }
    if (c.uniforms && lightMat?.uniforms) {
      for (const k of ["daytime", "lightVol", "lightVolOrigin", "lightVolSize", "lightVolTex", "lightVolCols"]) {
        if (lightMat.uniforms[k]) c.uniforms[k] = lightMat.uniforms[k]
      }
      if (lightMat.defines?.LIGHT_VOLUME !== undefined) c.defines = { ...c.defines, LIGHT_VOLUME: "" }
    }
    return c
  })
  return Array.isArray(mat) ? out : out[0]
}

function setInstance(slots, key, slot, pos, rot, visible) {
  const s = slots.get(key)
  if (!s) return
  for (const m of s.meshes) {
    if (visible) m.im.setMatrixAt(slot, _dm.makeTranslation(pos[0] * 16, pos[1] * 16, pos[2] * 16).multiply(rot).multiply(m.base))
    else m.im.setMatrixAt(slot, _dzero)
    m.im.instanceMatrix.needsUpdate = true
  }
}

// builds the door meshes for one tile; returns a registry or null
export async function attachTileDoors({ lib, assets, doors, group, lightMat, onToggle }) {
  if (!doors?.length) return null
  const regs = new Map()
  const slots = new Map()
  const entries = []
  // canonical template builds are the expensive part; time-slice them so a
  // tile full of new door types never blocks a frame
  let sliceT = performance.now()
  for (const d of doors) {
    const props = d.properties ?? {}
    const openInfo = await ensureState(lib, assets, d.id, { ...props, open: "true" })
    const closedInfo = await ensureState(lib, assets, d.id, { ...props, open: "false" })
    if (performance.now() - sliceT > 5) {
      await new Promise(r => requestAnimationFrame(r))
      sliceT = performance.now()
    }
    if (!openInfo.key || !closedInfo.key) continue
    const slotFor = info => {
      let s = slots.get(info.key)
      if (!s) slots.set(info.key, s = { count: 0, meshes: [] })
      return s.count++
    }
    entries.push({ d, openInfo, closedInfo, openSlot: slotFor(openInfo), closedSlot: slotFor(closedInfo) })
  }
  if (!entries.length) return null
  for (const [key, s] of slots) {
    const parts = canonParts.get(key)
    if (!parts) continue
    for (const p of parts) {
      const im = new THREE.InstancedMesh(p.geometry, cloneMaterialFor(p.material, lightMat), s.count)
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false
      for (let i = 0; i < s.count; i++) im.setMatrixAt(i, _dzero)
      group.add(im)
      s.meshes.push({ im, base: p.base })
    }
  }
  for (const e of entries) {
    const open = (e.d.properties?.open ?? "false") === "true"
    setInstance(slots, e.openInfo.key, e.openSlot, e.d.pos, e.openInfo.rot, open)
    setInstance(slots, e.closedInfo.key, e.closedSlot, e.d.pos, e.closedInfo.rot, !open)
    regs.set(e.d.pos.join(","), {
      pos: e.d.pos, id: e.d.id, props: { ...(e.d.properties ?? {}) },
      openInfo: e.openInfo, closedInfo: e.closedInfo,
      openSlot: e.openSlot, closedSlot: e.closedSlot, pair: null
    })
  }
  for (const reg of regs.values()) {
    if (!/(^|:)([a-z_]+_)?door$/.test(reg.id)) continue
    const [x, y, z] = reg.pos
    reg.pair = regs.get(x + "," + (y + 1) + "," + z) || regs.get(x + "," + (y - 1) + "," + z) || null
  }
  return {
    regs,
    dispose() {
      for (const s of slots.values()) for (const m of s.meshes) {
        m.im.removeFromParent()
        for (const mt of [].concat(m.im.material)) { try { mt.dispose() } catch {} }
      }
    },
    toggle(reg) {
      const open = reg.props.open !== "true"
      const pairs = reg.pair ? [reg, reg.pair] : [reg]
      for (const r of pairs) {
        r.props.open = open ? "true" : "false"
        setInstance(slots, r.openInfo.key, r.openSlot, r.pos, r.openInfo.rot, open)
        setInstance(slots, r.closedInfo.key, r.closedSlot, r.pos, r.closedInfo.rot, !open)
      }
      onToggle?.()
      return pairs.map(r => ({ pos: r.pos, id: r.id, properties: r.props }))
    },
    boxesFor(reg) {
      const info = reg.props.open === "true" ? reg.openInfo : reg.closedInfo
      const boxes = boxCache.get(info.key) ?? []
      const out = []
      const m = _dm.copy(info.rot)
      for (const b of boxes) {
        _cb.min.set(b[0], b[1], b[2])
        _cb.max.set(b[3], b[4], b[5])
        _cb.applyMatrix4(m)
        out.push([_cb.min.x, _cb.min.y, _cb.min.z, _cb.max.x, _cb.max.y, _cb.max.z])
      }
      return out
    }
  }
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
