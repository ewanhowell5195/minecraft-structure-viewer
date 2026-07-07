import * as THREE from "three"

// Merge the built block templates + block list into a few atlased, greedily
// meshed groups, so a wall of different blocks becomes ~one draw call.
// Materials differing only in texture share one sheet; animated blocks (water,
// lava) stay live. optimise(structure, templates, position, { getCullFaces,
// setStatus }) -> { group, atlasTextures, drawCalls, tris }
const DIRS = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] }
const DIR_NAMES = Object.keys(DIRS)
const MAX_ATLAS = 8192   // spill to another atlas past this
const MAX_TILE = 512     // cap a pre-tiled texture per side; larger runs split into chunks

const matMap = m => m.uniforms?.map?.value ?? m.map
const matAnimated = m => !!(m.uniforms?.GameTime || matMap(m)?.userData?.frames)

function matSignature(m) {
  if (m.uniforms) { // library shader material: group by every setting but the map
    const u = m.uniforms
    return ["shader", m.side, u.shadeEnabled?.value, u.d0?.value, u.d1?.value, u.ambient?.value,
      u.light0?.value?.toArray().join(","), u.light1?.value?.toArray().join(",")].join("|")
  }
  return [m.type, m.side].join("|")
}

// pixel reads happen once per texture; keep the canvas CPU-side so
// getImageData doesn't stall on a GPU readback each time
const _hashCanvas = new OffscreenCanvas(1, 1)
const _hashCtx = _hashCanvas.getContext("2d", { willReadFrequently: true })

function pixelData(img) {
  _hashCanvas.width = img.width
  _hashCanvas.height = img.height
  _hashCtx.clearRect(0, 0, img.width, img.height)
  _hashCtx.drawImage(img, 0, 0)
  return _hashCtx.getImageData(0, 0, img.width, img.height).data
}

const opaqueCache = new WeakMap()
function isOpaque(tex) {
  let o = opaqueCache.get(tex)
  if (o !== undefined) return o
  const d = pixelData(tex.image)
  o = true
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { o = false; break }
  opaqueCache.set(tex, o)
  return o
}

// truly see-through (stained glass, ice): any partial alpha. cutouts (alpha
// only 0/255, e.g. leaves) are NOT translucent: they belong in the opaque
// pass so they depth-write and don't hide geometry behind them
const translucentCache = new WeakMap()
function isTranslucent(tex) {
  let t = translucentCache.get(tex)
  if (t !== undefined) return t
  const d = pixelData(tex.image)
  t = false
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 255) { t = true; break }
  translucentCache.set(tex, t)
  return t
}

// hash a texture by its pixels so identical images (the same block texture
// reached through different palette entries) pack into the sheet once. keyed
// by the image, so pseudo-textures sharing a cached tiled canvas share a hash
const texHash = new WeakMap()
function hashTexture(tex) {
  const img = tex.image
  let h = texHash.get(img)
  if (h !== undefined) return h
  const d = pixelData(img)
  let v = 2166136261
  for (let i = 0; i < d.length; i++) { v ^= d[i]; v = Math.imul(v, 16777619) }
  h = `${v >>> 0}_${img.width}x${img.height}`
  texHash.set(img, h)
  return h
}

// extract one flat, axis-aligned rectangular face from a geometry group, in
// the template's local frame, so ANY block's flat faces (cubes, slabs, stairs,
// walls) can be greedy-merged. returns null for non-axis-aligned /
// non-rectangular / degenerate faces, which fall back to the atlas path.
const _ef = new THREE.Vector3()
function extractFlat(geo, grp, mw, nm, tex, mat, cull) {
  const pos = geo.attributes.position, uv = geo.attributes.uv, nrm = geo.attributes.normal, idx = geo.index
  if (!uv) return null
  _ef.fromBufferAttribute(nrm, idx.getX(grp.start)).applyMatrix3(nm).normalize()
  const na = Math.abs(_ef.x) > 0.99 ? 0 : Math.abs(_ef.y) > 0.99 ? 1 : Math.abs(_ef.z) > 0.99 ? 2 : -1
  if (na < 0) return null
  const ns = _ef.getComponent(na) > 0 ? 1 : -1
  const [pa, pb] = [0, 1, 2].filter(a => a !== na)
  const P = []
  let pc = null
  for (let i = grp.start; i < grp.start + grp.count; i++) {
    const a = idx.getX(i)
    _ef.fromBufferAttribute(pos, a).applyMatrix4(mw)
    const cn = _ef.getComponent(na)
    if (pc === null) pc = cn
    else if (Math.abs(cn - pc) > 0.01) return null
    P.push({ a: _ef.getComponent(pa), b: _ef.getComponent(pb), u: uv.getX(a), v: uv.getY(a) })
  }
  const a0 = Math.min(...P.map(p => p.a)), a1 = Math.max(...P.map(p => p.a))
  const b0 = Math.min(...P.map(p => p.b)), b1 = Math.max(...P.map(p => p.b))
  const wa = a1 - a0, wb = b1 - b0
  if (wa < 0.01 || wb < 0.01) return null
  for (const p of P) if ((Math.abs(p.a - a0) > 0.01 && Math.abs(p.a - a1) > 0.01) || (Math.abs(p.b - b0) > 0.01 && Math.abs(p.b - b1) > 0.01)) return null
  const umin = Math.min(...P.map(p => p.u)), umax = Math.max(...P.map(p => p.u))
  const vmin = Math.min(...P.map(p => p.v)), vmax = Math.max(...P.map(p => p.v))
  if (umax - umin < 1e-4 || vmax - vmin < 1e-4) return null
  const c0 = P.find(p => Math.abs(p.a - a0) < 0.01)
  const c1 = P.find(p => Math.abs(p.a - a1) < 0.01 && Math.abs(p.b - c0.b) < 0.01)
  if (!c1) return null
  const uAxisIsPa = Math.abs(c1.u - c0.u) > Math.abs(c1.v - c0.v)
  // source sub-rect the face samples
  const tw = tex.image.width, th = tex.image.height
  const sub = { sx: Math.round(umin * tw), sy: Math.round((1 - vmax) * th), sw: Math.round((umax - umin) * tw), sh: Math.round((vmax - vmin) * th) }
  if (sub.sw < 1 || sub.sh < 1) return null
  const verts = P.map(p => ({ ha: Math.abs(p.a - a1) < 0.01 ? 1 : 0, hb: Math.abs(p.b - b1) < 0.01 ? 1 : 0, u: (p.u - umin) / (umax - umin), v: (p.v - vmin) / (vmax - vmin) }))
  const srcHash = hashTexture(tex)
  // canonical corner->uv map (not raw vertex order): a slab top, a stair top
  // and a full-cube top sharing one texture merge despite different windings
  const corners = {}
  for (const c of verts) corners[`${c.ha}${c.hb}`] = `${c.u.toFixed(2)},${c.v.toFixed(2)}`
  const orient = Object.keys(corners).sort().map(k => k + ":" + corners[k]).join("|")
  const cellKey = `${srcHash}:${sub.sx},${sub.sy},${sub.sw},${sub.sh}:${wa.toFixed(2)}x${wb.toFixed(2)}:${orient}`
  return { na, ns, pa, pb, pc, a0, b0, wa, wb, uAxisIsPa, sub, verts, sig: matSignature(mat), tex, mat, srcHash, cull, cellKey }
}

// a group can hold many quads (fences, chests: several elements sharing one
// material slot). split it into consecutive two-triangle windows and extract
// each; a window that isn't a clean quad sends the whole group to the atlas
// path unchanged
function extractFlats(geo, grp, mw, nm, tex, mat, cull) {
  if (grp.count % 6) return null
  const out = []
  for (let s = grp.start; s < grp.start + grp.count; s += 6) {
    const flat = extractFlat(geo, { start: s, count: 6 }, mw, nm, tex, mat, cull)
    if (!flat) return null
    out.push({ flat, start: s, count: 6 })
  }
  return out
}

// coplanar flats whose rectangles overlap (grass side + tinted overlay) must
// stay on the atlas path in submission order, else they z-fight
const rectsOverlap = (f, g) => f.a0 < g.a0 + g.wa - 0.01 && g.a0 < f.a0 + f.wa - 0.01 && f.b0 < g.b0 + g.wb - 0.01 && g.b0 < f.b0 + f.wb - 0.01

// pre-tiled texture cache: cell key + repeats -> canvas
const tiledCache = new Map()
function tiledSub(srcImg, key, sub, ur, vr) {
  const k = key + "|" + ur + "x" + vr
  let c = tiledCache.get(k)
  if (c) return c
  c = new OffscreenCanvas(sub.sw * ur, sub.sh * vr)
  const ctx = c.getContext("2d")
  for (let j = 0; j < vr; j++) for (let i = 0; i < ur; i++) ctx.drawImage(srcImg, sub.sx, sub.sy, sub.sw, sub.sh, i * sub.sw, j * sub.sh, sub.sw, sub.sh)
  tiledCache.set(k, c)
  return c
}

// greedily merge a set of "a,b" plane cells into maximal rectangles
function greedyRects(cellSet) {
  const done = new Set(), rects = []
  const coords = [...cellSet].map(s => s.split(",").map(Number)).sort((p, q) => p[1] - q[1] || p[0] - q[0])
  for (const [a, b] of coords) {
    if (done.has(a + "," + b)) continue
    let a1 = a
    while (cellSet.has((a1 + 1) + "," + b) && !done.has((a1 + 1) + "," + b)) a1++
    let b1 = b, grow = true
    while (grow) {
      for (let x = a; x <= a1; x++) if (!cellSet.has(x + "," + (b1 + 1)) || done.has(x + "," + (b1 + 1))) { grow = false; break }
      if (grow) b1++
    }
    for (let y = b; y <= b1; y++) for (let x = a; x <= a1; x++) done.add(x + "," + y)
    rects.push([a, a1, b, b1])
  }
  return rects
}

// pack textures into atlases with a 1px extruded gutter (nearest-filter never
// bleeds), deduped by pixel hash, spilling past MAX_ATLAS
function buildAtlas(textures) {
  const pad = 1
  const rep = new Map()
  for (const t of textures) { const h = hashTexture(t); if (!rep.has(h)) rep.set(h, t) }
  const items = [...rep.values()].map(t => ({ t, img: t.image, w: t.image.width, h: t.image.height }))
  items.sort((a, b) => b.h - a.h)
  let ai = 0, x = 0, y = 0, rowH = 0
  const sizes = [{ w: 0, h: 0 }]
  for (const it of items) {
    const cw = it.w + pad * 2, ch = it.h + pad * 2
    if (x + cw > MAX_ATLAS) { y += rowH; x = 0; rowH = 0 }
    if (y + ch > MAX_ATLAS) { ai++; x = 0; y = 0; rowH = 0; sizes[ai] = { w: 0, h: 0 } }
    it.ai = ai; it.px = x; it.py = y
    x += cw; rowH = Math.max(rowH, ch)
    sizes[ai].w = Math.max(sizes[ai].w, x)
    sizes[ai].h = Math.max(sizes[ai].h, y + rowH)
  }
  const ctxs = sizes.map(s => new OffscreenCanvas(s.w, s.h).getContext("2d"))
  const byHash = new Map()
  for (const it of items) {
    const ctx = ctxs[it.ai], dx = it.px + pad, dy = it.py + pad, { w, h, img } = it
    ctx.drawImage(img, dx, dy)
    ctx.drawImage(img, 0, 0, w, 1, dx, dy - 1, w, 1)
    ctx.drawImage(img, 0, h - 1, w, 1, dx, dy + h, w, 1)
    ctx.drawImage(img, 0, 0, 1, h, dx - 1, dy, 1, h)
    ctx.drawImage(img, w - 1, 0, 1, h, dx + w, dy, 1, h)
    byHash.set(hashTexture(it.t), { ai: it.ai, x: dx, y: dy, w, h })
  }
  const atlases = ctxs.map(ctx => {
    const a = new THREE.CanvasTexture(ctx.canvas)
    a.magFilter = a.minFilter = THREE.NearestFilter
    a.generateMipmaps = false
    a.colorSpace = textures[0].colorSpace
    return a
  })
  const rects = new Map()
  for (const t of textures) rects.set(t, byHash.get(hashTexture(t)))
  return { atlases, rects, sizes }
}

// append an indexed triangle range, transformed to world space, with UVs
// remapped into the atlas rect (atlas + source share flipY)
const _v = new THREE.Vector3(), _n = new THREE.Vector3()
function appendGroup(geo, start, count, mat, nmat, rect, W, H, acc) {
  const idx = geo.index, pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv
  for (let i = start; i < start + count; i++) {
    const a = idx.getX(i)
    _v.fromBufferAttribute(pos, a).applyMatrix4(mat)
    _n.fromBufferAttribute(nrm, a).applyMatrix3(nmat).normalize()
    const u = uv.getX(a), v = uv.getY(a)
    acc.P.push(_v.x, _v.y, _v.z)
    acc.N.push(_n.x, _n.y, _n.z)
    if (rect) acc.U.push((rect.x + u * rect.w) / W, 1 - (rect.y + (1 - v) * rect.h) / H)
    else acc.U.push(u, v)
  }
}

export async function optimise(structure, templates, position, { getCullFaces, setStatus }) {
  setStatus?.("optimising…")
  tiledCache.clear()
  const pending = []
  await new Promise(r => setTimeout(r))

  // per-block cull sets, memoised on (state, 6 neighbour states): structures
  // are repetitive, so most blocks share an answer
  const posState = new Map()
  for (const b of structure.blocks) posState.set(b.pos.join(","), b.state)
  const cullMemo = new Map(), cullSets = new Map()
  for (const b of structure.blocks) {
    const entry = structure.palette[b.state]
    if (!entry?.Name) continue
    const nStates = DIR_NAMES.map(dir => {
      const [dx, dy, dz] = DIRS[dir]
      return posState.get((b.pos[0] + dx) + "," + (b.pos[1] + dy) + "," + (b.pos[2] + dz))
    })
    const mkey = b.state + "|" + nStates.join(",")
    let cull = cullMemo.get(mkey)
    if (cull === undefined) {
      const neighbors = {}
      for (let i = 0; i < 6; i++) {
        const ne = nStates[i] === undefined ? null : structure.palette[nStates[i]]
        if (ne?.Name) neighbors[DIR_NAMES[i]] = { id: ne.Name, ...(ne.Properties ?? {}) }
      }
      cull = await getCullFaces({ id: entry.Name, blockstates: entry.Properties ?? {}, neighbors })
      cullMemo.set(mkey, cull)
    }
    cullSets.set(b.pos.join(","), cull)
  }
  const hidden = (b, dir) => cullSets.get(b.pos.join(","))?.has(dir) === true

  // classify each template's faces: flat axis-aligned rectangles are
  // greedy-meshable; animated faces stay live; everything else goes to the
  // atlas per block. coplanar overlapping flats are demoted to the atlas path.
  const atlasGroups = new Map()
  const anims = new Map(), animTexId = new Map()
  const tdata = new Map()
  for (const [state, tmpl] of templates) {
    if (!tmpl) continue
    tmpl.updateMatrixWorld(true)
    const flats = [], meshMap = new Map()
    const atlasFace = (o, face) => {
      let m = meshMap.get(o)
      if (!m) meshMap.set(o, m = { geo: o.geometry, matrix: o.matrixWorld.clone(), faces: [] })
      m.faces.push(face)
    }
    const toAtlas = (mat, tex, face) => {
      const translucent = isTranslucent(tex)
      const sig = matSignature(mat) + (translucent ? "|T" : "|O")
      let grp = atlasGroups.get(sig)
      if (!grp) atlasGroups.set(sig, grp = { textures: new Set(), repMat: mat, translucent })
      grp.textures.add(tex)
      return { ...face, sig }
    }
    tmpl.traverse(o => {
      if (!o.isMesh) return
      const geo = o.geometry, mats = [].concat(o.material)
      const nm = new THREE.Matrix3().getNormalMatrix(o.matrixWorld)
      const gs = geo.groups.length ? geo.groups : [{ start: 0, count: geo.index.count, materialIndex: 0 }]
      for (const g of gs) {
        const mat = mats[g.materialIndex]
        if (!mat || mat.visible === false) continue
        const tex = matMap(mat)
        if (!tex) continue
        const cull = o.userData.cullface?.[g.materialIndex] ?? null
        if (matAnimated(mat)) {
          if (!animTexId.has(tex)) animTexId.set(tex, animTexId.size)
          const key = matSignature(mat) + "|a" + animTexId.get(tex)
          // fix the live material in place (cloning would clone the animated
          // texture and break it): opaque animated (lava) renders in the
          // opaque pass, translucent (water) blends without writing depth
          if (!anims.has(key)) {
            const tr = isTranslucent(tex)
            mat.transparent = tr
            mat.depthWrite = !tr
            anims.set(key, { material: mat, acc: { P: [], N: [], U: [] } })
          }
          atlasFace(o, { start: g.start, count: g.count, animKey: key, cull })
          continue
        }
        const fls = extractFlats(geo, g, o.matrixWorld, nm, tex, mat, cull)
        if (fls) for (const fl of fls) flats.push({ flat: fl.flat, o, mat, tex, start: fl.start, count: fl.count, cull })
        else atlasFace(o, toAtlas(mat, tex, { start: g.start, count: g.count, tex, cull }))
      }
    })
    const byPlane = new Map()
    for (const c of flats) {
      const f = c.flat, k = f.na + "|" + f.ns + "|" + Math.round(f.pc * 100)
      let arr = byPlane.get(k)
      if (!arr) byPlane.set(k, arr = [])
      arr.push(c)
    }
    // overlapping coplanar flats: a face strictly contained inside an opaque
    // one (a fence arm's end flush against the post) is invisible, drop it.
    // same-material opaque overlaps (interpenetrating fence rails) are fine
    // to keep: they share one buffer so draw order is stable and the texels
    // match. only cross-material overlaps (grass side + tinted overlay) must
    // demote to the ordered atlas path
    const contains = (f, g) => f.a0 <= g.a0 + 0.01 && f.a0 + f.wa >= g.a0 + g.wa - 0.01 && f.b0 <= g.b0 + 0.01 && f.b0 + f.wb >= g.b0 + g.wb - 0.01
    const demote = new Set(), drop = new Set()
    for (const arr of byPlane.values()) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const A = arr[i], B = arr[j]
      if (!rectsOverlap(A.flat, B.flat)) continue
      const areaA = A.flat.wa * A.flat.wb, areaB = B.flat.wa * B.flat.wb
      if (contains(A.flat, B.flat) && areaB < areaA - 0.01 && isOpaque(A.tex)) drop.add(B)
      else if (contains(B.flat, A.flat) && areaA < areaB - 0.01 && isOpaque(B.tex)) drop.add(A)
      else if (A.flat.sig !== B.flat.sig || A.tex !== B.tex || !isOpaque(A.tex) || !isOpaque(B.tex)) { demote.add(A); demote.add(B) }
    }
    const merge = []
    for (const c of flats) {
      if (drop.has(c)) continue
      if (demote.has(c)) atlasFace(c.o, toAtlas(c.mat, c.tex, { start: c.start, count: c.count, tex: c.tex, cull: c.cull }))
      else merge.push(c.flat)
    }
    tdata.set(state, { merge, meshes: [...meshMap.values()] })
  }

  // greedy: bucket flat faces by (plane, normal, cell, phase) across all
  // placed blocks; phase = world offset mod cell size so equal faces at odd
  // offsets still align to a lattice
  const grids = new Map()
  for (const b of structure.blocks) {
    const td = tdata.get(b.state)
    if (!td) continue
    for (const f of td.merge) {
      if (f.cull && hidden(b, f.cull)) continue
      const wpc = f.pc + b.pos[f.na] * 16
      const wa0 = f.a0 + b.pos[f.pa] * 16, wb0 = f.b0 + b.pos[f.pb] * 16
      const phaseA = ((wa0 % f.wa) + f.wa) % f.wa, phaseB = ((wb0 % f.wb) + f.wb) % f.wb
      const key = f.na + "|" + wpc.toFixed(2) + "|" + f.ns + "|" + f.cellKey + "|" + phaseA.toFixed(2) + "|" + phaseB.toFixed(2)
      let grid = grids.get(key)
      if (!grid) grids.set(key, grid = { f, wpc, phaseA, phaseB, cells: new Set() })
      grid.cells.add(Math.round((wa0 - phaseA) / f.wa) + "," + Math.round((wb0 - phaseB) / f.wb))
    }
  }
  const greedyQuads = []
  for (const grid of grids.values()) {
    const f = grid.f
    const translucent = isTranslucent(f.tex)
    const sig = f.sig + (translucent ? "|T" : "|O")
    let grp = atlasGroups.get(sig)
    if (!grp) atlasGroups.set(sig, grp = { textures: new Set(), repMat: f.mat, translucent })
    const maxA = Math.max(1, Math.floor(MAX_TILE / f.sub.sw)), maxB = Math.max(1, Math.floor(MAX_TILE / f.sub.sh))
    for (const [i0, i1, j0, j1] of greedyRects(grid.cells)) {
      for (let ci = i0; ci <= i1; ci += maxA) for (let cj = j0; cj <= j1; cj += maxB) {
        const ei = Math.min(ci + maxA - 1, i1), ej = Math.min(cj + maxB - 1, j1)
        const Na = ei - ci + 1, Nb = ej - cj + 1
        const wALo = grid.phaseA + ci * f.wa, wAHi = grid.phaseA + (ei + 1) * f.wa
        const wBLo = grid.phaseB + cj * f.wb, wBHi = grid.phaseB + (ej + 1) * f.wb
        const ur = f.uAxisIsPa ? Na : Nb, vr = f.uAxisIsPa ? Nb : Na
        const pseudo = { image: tiledSub(f.tex.image, f.cellKey, f.sub, ur, vr), colorSpace: f.tex.colorSpace }
        grp.textures.add(pseudo)
        greedyQuads.push({ sig, pseudo, f, wpc: grid.wpc, wALo, wAHi, wBLo, wBHi })
      }
    }
  }

  // atlases per signature; opaque groups depth-write in the opaque pass,
  // translucent ones draw transparent WITHOUT depth write (with it, whichever
  // glass face draws first in the merged mesh hard-occludes the ones behind)
  const atlases = new Map()
  for (const [sig, grp] of atlasGroups) {
    const { atlases: ats, rects, sizes } = buildAtlas([...grp.textures])
    pending.push(...ats)
    const materials = ats.map(a => {
      const m = grp.repMat.clone()
      if (m.uniforms) m.uniforms.map.value = a
      else m.map = a
      m.transparent = grp.translucent
      m.depthWrite = !grp.translucent
      return m
    })
    atlases.set(sig, { rects, sizes, materials, accs: ats.map(() => ({ P: [], N: [], U: [] })) })
  }

  // accumulate per-block atlas + animated faces (culled)
  const blockT = new THREE.Matrix4(), full = new THREE.Matrix4(), nmat = new THREE.Matrix3()
  for (let i = 0; i < structure.blocks.length; i++) {
    const b = structure.blocks[i]
    const td = tdata.get(b.state)
    if (!td) continue
    blockT.makeTranslation(b.pos[0] * 16, b.pos[1] * 16, b.pos[2] * 16)
    for (const m of td.meshes) {
      full.multiplyMatrices(blockT, m.matrix)
      nmat.getNormalMatrix(full)
      for (const f of m.faces) {
        if (f.cull && hidden(b, f.cull)) continue
        if (f.animKey) appendGroup(m.geo, f.start, f.count, full, nmat, null, 0, 0, anims.get(f.animKey).acc)
        else {
          const at = atlases.get(f.sig), rect = at.rects.get(f.tex), s = at.sizes[rect.ai]
          appendGroup(m.geo, f.start, f.count, full, nmat, rect, s.w, s.h, at.accs[rect.ai])
        }
      }
    }
    if (i % 2000 === 1999) {
      setStatus?.(`optimising… ${i + 1}/${structure.blocks.length}`)
      await new Promise(r => setTimeout(r))
    }
  }

  // emit greedy quads (positions at the merged rect, uv 0..1 into the
  // pre-tiled cell's atlas rect; orientation lives in the per-vert uv)
  for (const q of greedyQuads) {
    const at = atlases.get(q.sig), rect = at.rects.get(q.pseudo), s = at.sizes[rect.ai], acc = at.accs[rect.ai], f = q.f
    for (const vert of f.verts) {
      const p = [0, 0, 0], nn = [0, 0, 0]
      p[f.na] = q.wpc
      p[f.pa] = vert.ha ? q.wAHi : q.wALo
      p[f.pb] = vert.hb ? q.wBHi : q.wBLo
      nn[f.na] = f.ns
      acc.P.push(p[0], p[1], p[2])
      acc.N.push(nn[0], nn[1], nn[2])
      acc.U.push((rect.x + vert.u * rect.w) / s.w, 1 - (rect.y + (1 - vert.v) * rect.h) / s.h)
    }
  }

  const opt = new THREE.Group()
  opt.position.copy(position)
  let drawCalls = 0, tris = 0
  const addMesh = (acc, material) => {
    if (!acc.P.length) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.Float32BufferAttribute(acc.P, 3))
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(acc.N, 3))
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(acc.U, 2))
    opt.add(new THREE.Mesh(geo, material))
    drawCalls++
    tris += acc.P.length / 9
  }
  for (const { materials, accs } of atlases.values()) accs.forEach((acc, i) => addMesh(acc, materials[i]))
  for (const { material, acc } of anims.values()) addMesh(acc, material)

  return { group: opt, atlasTextures: pending, drawCalls, tris }
}
