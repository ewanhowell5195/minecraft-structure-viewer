import { loadLibrary, THREE } from "./lib.js"
import { ensureRaw } from "./blocklist.js"
import { saveBlob } from "./download.js"
import { usePacks } from "./composables/usePacks.js"
import { useBuild, cushionOf, DEFAULT_DAYTIME } from "./composables/useBuild.js"

const VERSION = 4
const SCALE = 256
const CELL = 16
const INSET = 1 / 32
const MAX_ANIMATIONS = 31
const VERTEX_BYTES = 16
const AO_EDGE = 0.0117
const AIR = /(^|:)(air|cave_air|void_air)$/
const BANNER = /(^|_)banner$/
const FLUID = /(^|:)(water|lava|bubble_column)$/
const MAX_LEVELS = 8
const EDGE = 1 / 1024

const mix = (a, b, t) => a + (b - a) * t
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const vec = v => [v.x, v.y, v.z]

function sceneBlocks(structure, cull) {
  const palette = structure.palette.map(e => e?.id && !AIR.test(e.id) ? { id: e.id, properties: e.properties, biome: e.__biome } : null)
  const blockNbt = new Map()
  for (const [i, nbt] of structure.blockNbt) {
    const patterns = nbt?.patterns ?? nbt?.Patterns
    if (patterns && BANNER.test(structure.palette[structure.raw[i * 4]]?.id ?? "")) blockNbt.set(cull ? i : i * 2 + 1, { patterns })
  }
  if (cull) return { palette, raw: structure.raw, blockNbt }
  const doubled = palette.flatMap(e => e && !FLUID.test(e.id) ? [Object.assign({}, e, { context: true }), Object.assign({}, e, { overlay: true })] : [e, null])
  const raw = new Int32Array(structure.raw.length * 2)
  for (let i = 0; i < structure.raw.length; i += 4) {
    const [state, x, y, z] = structure.raw.subarray(i, i + 4)
    raw.set([state * 2, x, y, z, doubled[state * 2 + 1] ? state * 2 + 1 : state * 2, x, y, z], i * 2)
  }
  return { palette: doubled, raw, blockNbt }
}

function firstLevels(levels) {
  if (levels.length > MAX_LEVELS) throw new Error(`bake: at most ${MAX_LEVELS} levels fit in a vertex`)
  const first = new Map()
  levels.forEach((keys, level) => {
    for (const key of keys) if (!first.has(key)) first.set(key, level)
  })
  return first
}

function blockBounds(blocks) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  const raw = blocks.raw
  for (let i = 0; i < raw.length; i += 4) {
    if (!blocks.palette[raw[i]]) continue
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], raw[i + 1 + a])
      max[a] = Math.max(max[a], raw[i + 1 + a])
    }
  }
  if (min[0] === Infinity) throw new Error("bake: the loaded structure has no blocks")
  return { min, max }
}

function lightSampler(light) {
  const u = light.uniforms
  if (!u.lightAoCols) throw new Error("bake: the light volume has no neighbour occlusion texture, the viewer needs a WebGL2 renderer")
  const levels = u.lightVol.value.image.data, near = u.lightAo.value.image.data
  if (!levels || !near) throw new Error("bake: the light volume's textures were released")
  const [w, h, d] = light.size
  const cols = u.lightVolCols.value, texW = u.lightVolTex.value.x
  const aoCols = u.lightAoCols.value, aoW = u.lightAoTex.value.x

  function lattice(x, y, z) {
    return ((Math.floor(y / cols) * (d + 1) + z) * texW + (y % cols) * (w + 1) + x) * 2
  }

  function level(p) {
    const x = clamp(p[0], 0, w), y = clamp(p[1], 0, h), z = clamp(p[2], 0, d)
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
    const x1 = Math.min(x0 + 1, w), y1 = Math.min(y0 + 1, h), z1 = Math.min(z0 + 1, d)
    const out = [0, 0]
    for (let c = 0; c < 2; c++) {
      const at = (lx, ly, lz) => levels[lattice(lx, ly, lz) + c]
      const low = mix(mix(at(x0, y0, z0), at(x1, y0, z0), x - x0), mix(at(x0, y0, z1), at(x1, y0, z1), x - x0), z - z0)
      const high = mix(mix(at(x0, y1, z0), at(x1, y1, z0), x - x0), mix(at(x0, y1, z1), at(x1, y1, z1), x - x0), z - z0)
      out[c] = mix(low, high, y - y0) / 255
    }
    return out
  }

  function neighbours(cell) {
    const x = clamp(cell[0], -1, w) + 1, y = clamp(cell[1], -1, h) + 1, z = clamp(cell[2], -1, d) + 1
    const i = ((Math.floor(y / aoCols) * (d + 2) + z) * aoW + (y % aoCols) * (w + 2) + x) * 4
    return [near[i], near[i + 1], near[i + 2], near[i + 3]]
  }

  function occlusion(p, inside, normal) {
    const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2])
    const axis = ay >= ax && ay >= az ? 1 : ax >= az ? 0 : 2
    const t1 = axis === 0 ? 1 : 0, t2 = axis === 2 ? 1 : 2
    const side = Math.sign(normal[axis])
    const base = inside.map((c, a) => Math.floor(a === axis ? c - side * AO_EDGE : c))
    const edge = inside[axis] - Math.floor(inside[axis])
    if (edge < AO_EDGE || edge > 1 - AO_EDGE) base[axis] += side
    const nb = neighbours(base)
    const planes = axis === 0 ? [nb[0], nb[2], nb[1]] : axis === 2 ? [nb[2], nb[1], nb[0]] : [nb[1], nb[2], nb[0]]
    const along = side < 0 ? [1, 4] : [32, 128], across = side < 0 ? [1, 32] : [4, 128]
    const placeA = axis === 0 ? across : along, placeB = axis === 2 ? along : across
    const bit = (bits, place) => bits & place ? 0.2 : 1
    const centre = nb[3] > 127.5 ? 0.2 : 1
    const sA0 = bit(planes[0], 8), sA1 = bit(planes[0], 16), sB0 = bit(planes[0], 2), sB1 = bit(planes[0], 64)
    const eA0 = bit(planes[1], placeA[0]), eA1 = bit(planes[1], placeA[1]), eB0 = bit(planes[2], placeB[0]), eB1 = bit(planes[2], placeB[1])
    const corner = (eA, eB, sa, sb, diagonal) => (sa + sb + (eA < 0.5 && eB < 0.5 ? sa : diagonal) + centre) * 0.25
    const q00 = corner(eA0, eB0, sA0, sB0, bit(planes[0], 1)), q10 = corner(eA1, eB0, sA1, sB0, bit(planes[0], 4))
    const q01 = corner(eA0, eB1, sA0, sB1, bit(planes[0], 32)), q11 = corner(eA1, eB1, sA1, sB1, bit(planes[0], 128))
    const f1 = clamp(p[t1] - base[t1], 0, 1), f2 = clamp(p[t2] - base[t2], 0, 1)
    return mix(mix(q00, q10, f1), mix(q01, q11, f1), f2)
  }

  return { level, occlusion }
}

function skyLight(u) {
  const night = vec(u.skyLightColor.value)
  if (u.skyLightFactor.value >= 0) return { factor: u.skyLightFactor.value, color: night }
  const td = ((u.daytime.value - 730) % 24000 + 24000) % 24000 + 730
  const k = td < 11270 ? 0 : td < 13140 ? (td - 11270) / 1870 : td < 22860 ? 1 : 1 - (td - 22860) / 1870
  return { factor: mix(1, 0.24, k), color: night.map(c => mix(1, c, k)) }
}

function lightmap(env, block, sky) {
  const skyBrightness = sky / (4 - 3 * sky) * env.sky.factor
  const blockBrightness = block / (4 - 3 * block) * 1.4
  const warm = 0.9 * (2 * block - 1) * (2 * block - 1)
  const light = env.ambient.map((c, a) => clamp(c + env.sky.color[a] * skyBrightness + mix(env.blockTint[a], 1, warm) * blockBrightness, 0, 1))
  const max = Math.max(light[0], light[1], light[2])
  if (max <= 0) return light
  const scale = (1 - (1 - max) ** 4) / max
  return light.map(c => mix(c, c * scale, env.brightness))
}

function faceShade(u, normal) {
  if (!u.shadeEnabled.value || !u.shading.value) return 1
  const override = u.shadeOverride.value
  const n = override.lengthSq() > 0.5 ? vec(override) : vec(new THREE.Vector3(normal[0], normal[1], normal[2]).applyMatrix3(u.shadeMat.value))
  if (u.diffuseOn.value) {
    const dn = new THREE.Vector3(n[0], n[1], n[2]).normalize()
    return Math.min(1, (Math.max(0, u.diffuse0.value.dot(dn)) + Math.max(0, u.diffuse1.value.dot(dn))) * u.diffuseMix.value.x + u.diffuseMix.value.y)
  }
  const pos = u.shadePos.value, neg = u.shadeNeg.value
  const x2 = n[0] * n[0], y2 = n[1] * n[1], z2 = n[2] * n[2]
  return (y2 * (n[1] >= 0 ? pos.x : neg.x) + z2 * (n[2] >= 0 ? pos.y : neg.y) + x2 * (n[0] >= 0 ? pos.z : neg.z)) / (x2 + y2 + z2)
}

function materialInfo(material) {
  const u = material.uniforms, defines = material.defines ?? {}
  if (!material.isShaderMaterial || !u?.map?.value || u.worldShade?.value !== true) throw new Error(`bake: a ${material.type} that is not a world lit block material can't be baked`)
  for (const key of ["FACE_ATTRS", "TILED", "UV_OFFSET"]) if (key in defines) throw new Error(`bake: a material built with ${key} can't be baked`)
  if (u.opacity.value !== 1 || material.blending !== THREE.NormalBlending) throw new Error("bake: a material with its own opacity or blending can't be baked")
  if (u.fullbright.value || !u.ambientOcclusion.value) throw new Error("bake: the scene's lighting switches are not at their defaults")
  const texture = u.map.value
  const frames = texture.userData.frames?.length > 1 ? texture.userData.frames : null
  return {
    image: frames?.[0] ?? texture.image,
    frames,
    times: frames ? texture.userData.times ?? frames.map(() => 1) : null,
    interpolate: !!texture.userData.interpolate,
    blend: material.transparent,
    side: material.side,
    emission: u.emission.value,
    occluded: u.aoEnabled.value,
    env: { sky: skyLight(u), ambient: vec(u.ambientColor.value), blockTint: vec(u.blockLightTint.value), brightness: u.brightness.value }
  }
}

function sameVertex(i, j, position, uv) {
  return i === j || (position.getX(i) === position.getX(j) && position.getY(i) === position.getY(j) && position.getZ(i) === position.getZ(j) && uv.getX(i) === uv.getX(j) && uv.getY(i) === uv.getY(j))
}

function quadCorners(ids, position, uv) {
  const first = ids.slice(0, 3), second = ids.slice(3)
  const lone = first.filter(i => !second.some(j => sameVertex(i, j, position, uv)))
  const far = second.filter(j => !first.some(i => sameVertex(i, j, position, uv)))
  if (lone.length !== 1 || far.length !== 1) throw new Error("bake: a mesh has two triangles that do not share an edge, so they are not a quad")
  const at = first.indexOf(lone[0])
  return [first[(at + 1) % 3], far[0], first[(at + 2) % 3], lone[0]]
}

function collectQuads(group, light, centre) {
  const sampler = lightSampler(light)
  const materials = new Map(), tiles = new Map(), quads = []
  const point = new THREE.Vector3()

  function infoFor(material) {
    let info = materials.get(material)
    if (!info) materials.set(material, info = materialInfo(material))
    return info
  }

  function tileFor(info) {
    let tile = tiles.get(info.image)
    if (tile) return tile
    const images = info.frames ? Array.from(new Set(info.frames)) : [info.image]
    tile = { image: info.image, images, u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity }
    if (info.frames) tile.animation = { steps: info.frames.map(frame => images.indexOf(frame)), times: info.times, interpolate: info.interpolate }
    tiles.set(info.image, tile)
    return tile
  }

  function blockCell(mesh) {
    let root = mesh
    while (root.parent && root.parent !== group) root = root.parent
    return root.getWorldPosition(new THREE.Vector3()).toArray().map(c => Math.round(c / 16))
  }

  function addQuad(mesh, material, ids) {
    const { position, normal, uv, color } = mesh.geometry.attributes
    const info = infoFor(material), tile = tileFor(info), cell = blockCell(mesh)
    const cells = ids.map(i => point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).toArray().map(c => c / 16 + 0.5))
    const lit = cells.map(p => p.map((c, a) => c - light.origin[a]))
    const middle = [0, 1, 2].map(a => (lit[0][a] + lit[1][a] + lit[2][a] + lit[3][a]) / 4)
    const normalAt = point.fromBufferAttribute(normal, ids[0]).transformDirection(mesh.matrixWorld).toArray()
    const shade = faceShade(material.uniforms, normalAt)
    const mirrored = mesh.matrixWorld.determinant() < 0
    const [p0, p1, p2, p3] = cells.map(p => new THREE.Vector3(p[0], p[1], p[2]))
    const flat = Math.abs(p1.sub(p0).cross(p2.sub(p0)).dot(p3.sub(p0))) < 1e-6
    const brightness = vert => vert.rgb[0] + vert.rgb[1] + vert.rgb[2]
    for (const i of ids) {
      const u = uv.getX(i), v = uv.getY(i)
      if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) throw new Error("bake: a face has UVs outside its texture")
      tile.u0 = Math.min(tile.u0, u)
      tile.u1 = Math.max(tile.u1, u)
      tile.v0 = Math.min(tile.v0, v)
      tile.v1 = Math.max(tile.v1, v)
    }
    for (const front of info.side === THREE.DoubleSide ? [true, false] : [info.side === THREE.FrontSide]) {
      const facing = front ? normalAt : normalAt.map(c => -c)
      const verts = (front === mirrored ? [0, 3, 2, 1] : [0, 1, 2, 3]).map(k => {
        const i = ids[k], p = lit[k]
        const levels = sampler.level(p.map((c, a) => c + facing[a] * 0.5))
        const ao = info.occluded ? sampler.occlusion(p, p.map((c, a) => mix(c, middle[a], 0.01)), facing) : 1
        const tint = color ? [color.getX(i), color.getY(i), color.getZ(i)] : [1, 1, 1]
        const rgb = lightmap(info.env, Math.max(levels[0], info.emission), levels[1]).map((c, a) => clamp(c * ao * shade * tint[a], 0, 1))
        return { pos: cells[k].map((c, a) => c - centre[a]), uv: [uv.getX(i), uv.getY(i)], rgb }
      })
      if (flat && Math.abs(brightness(verts[0]) - brightness(verts[2])) > Math.abs(brightness(verts[1]) - brightness(verts[3]))) verts.push(verts.shift())
      quads.push({ tile, blend: info.blend, verts, cell })
    }
  }

  group.updateMatrixWorld(true)
  group.traverseVisible(mesh => {
    if (!mesh.isMesh) return
    if (mesh.isSkinnedMesh || mesh.userData.billboard) throw new Error("bake: skinned and camera facing meshes can't be baked")
    const { index, groups, attributes } = mesh.geometry
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const ranges = groups.length ? groups : [{ start: 0, count: index ? index.count : attributes.position.count, materialIndex: 0 }]
    for (const range of ranges) {
      const material = list[range.materialIndex]
      if (material.visible === false) continue
      if (range.count % 6) throw new Error("bake: a mesh is not built from quads")
      for (let i = range.start; i < range.start + range.count; i += 6) {
        const ids = [0, 1, 2, 3, 4, 5].map(k => index ? index.getX(i + k) : i + k)
        addQuad(mesh, material, quadCorners(ids, attributes.position, attributes.uv))
      }
    }
  })
  return { quads, tiles: Array.from(tiles.values()) }
}

function layoutAtlas(tiles) {
  let area = 0, widest = 0
  for (const tile of tiles) {
    const w = tile.image.width, h = tile.image.height
    if (tile.images.some(image => image.width !== w || image.height !== h)) throw new Error("bake: an animated texture has frames of different sizes")
    tile.x = clamp(Math.floor(tile.u0 * w + 1e-4), 0, w - 1)
    tile.y = clamp(Math.floor((1 - tile.v1) * h + 1e-4), 0, h - 1)
    tile.w = Math.max(Math.ceil(tile.u1 * w - 1e-4), tile.x + 1) - tile.x
    tile.h = Math.max(Math.ceil((1 - tile.v0) * h - 1e-4), tile.y + 1) - tile.y
    tile.cw = Math.ceil(tile.w / CELL) * CELL
    tile.ch = Math.ceil(tile.h / CELL) * CELL
    tile.regions = []
    area += tile.cw * tile.ch * tile.images.length
    widest = Math.max(widest, tile.cw)
  }
  const width = 2 ** Math.ceil(Math.log2(Math.max(widest, Math.sqrt(area))))
  const rects = tiles.flatMap(tile => tile.images.map(() => tile)).sort((a, b) => b.ch - a.ch || b.cw - a.cw)
  let x = 0, y = 0, row = 0
  for (const tile of rects) {
    if (x + tile.cw > width) {
      x = 0
      y += row
      row = 0
    }
    tile.regions.push([x, y])
    x += tile.cw
    row = Math.max(row, tile.ch)
  }
  for (const tile of tiles) [tile.ax, tile.ay] = tile.regions[0]
  return [width, y + row]
}

function animations(tiles, atlasSize) {
  const out = []
  for (const tile of tiles) {
    if (!tile.animation) continue
    if (out.length === MAX_ANIMATIONS) throw new Error(`bake: the scene has more than ${MAX_ANIMATIONS} animated textures`)
    tile.anim = out.length + 1
    const frames = tile.regions.map(([ax, ay]) => [(ax - tile.ax) / atlasSize[0], (ay - tile.ay) / atlasSize[1]])
    out.push({ frames, steps: tile.animation.steps, times: tile.animation.times, interpolate: tile.animation.interpolate })
  }
  return out
}

function imagePixels(image) {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  ctx.drawImage(image, 0, 0)
  return ctx.getImageData(0, 0, image.width, image.height).data
}

function drawAtlas(tiles, size) {
  const atlas = new ImageData(size[0], size[1])
  const out = new Uint32Array(atlas.data.buffer)
  for (const tile of tiles) {
    tile.images.forEach((image, k) => {
      const source = new Uint32Array(imagePixels(image).buffer)
      const [ax, ay] = tile.regions[k]
      for (let dy = 0; dy < tile.ch; dy++) {
        const sy = tile.y + Math.min(dy, tile.h - 1)
        for (let dx = 0; dx < tile.cw; dx++) out[(ay + dy) * size[0] + ax + dx] = source[sy * image.width + tile.x + Math.min(dx, tile.w - 1)]
      }
    })
  }
  const canvas = new OffscreenCanvas(size[0], size[1])
  canvas.getContext("2d").putImageData(atlas, 0, 0)
  return canvas.convertToBlob({ type: "image/png" })
}

function packVertices(quads, atlasSize) {
  const data = new DataView(new ArrayBuffer(quads.length * 4 * VERTEX_BYTES))
  let o = 0
  for (const quad of quads) {
    const { tile } = quad
    for (const vert of quad.verts) {
      for (let a = 0; a < 3; a++) {
        const value = Math.round(vert.pos[a] * SCALE)
        if (value < -32768 || value > 32767) throw new Error("bake: the scene is too large for 16 bit positions at 256 units a block")
        data.setInt16(o + a * 2, value, true)
      }
      const px = tile.ax + clamp(vert.uv[0] * tile.image.width - tile.x, INSET, tile.w - INSET), py = tile.ay + clamp((1 - vert.uv[1]) * tile.image.height - tile.y, INSET, tile.h - INSET)
      data.setUint16(o + 6, Math.round(px / atlasSize[0] * 65535), true)
      data.setUint16(o + 8, Math.round(py / atlasSize[1] * 65535), true)
      for (let a = 0; a < 3; a++) data.setUint8(o + 10 + a, Math.round(vert.rgb[a] * 255))
      data.setUint8(o + 13, tile.anim ?? 0)
      data.setUint8(o + 14, vert.build?.[0] ?? 0)
      data.setUint8(o + 15, vert.build?.[1] ?? 0)
      o += VERTEX_BYTES
    }
  }
  return data.buffer
}

function tagLevels(quads, levels, anchor, centre) {
  const first = firstLevels(levels)
  const rings = levels.map(() => [255, 0])
  for (const quad of quads) {
    const key = quad.cell.map((c, a) => c - anchor[a]).join(",")
    const level = first.get(key)
    if (level === undefined) throw new Error(`bake: the block at ${key}, relative to the start piece, is in none of the levels`)
    const middle = quad.cell.map((c, a) => c + 0.5 - centre[a])
    const ring = Math.round(Math.hypot(middle[0], middle[2]) * 2)
    if (ring > 255) throw new Error("bake: a block is more than 127 blocks from the centre, which does not fit the ring byte")
    rings[level] = [Math.min(rings[level][0], ring), Math.max(rings[level][1], ring)]
    quad.level = level
    const offsets = quad.verts.map(vert => vert.pos.map((c, a) => c - middle[a]))
    const whole = offsets.every(offset => offset.every(d => Math.abs(d) <= 0.5 + EDGE))
    quad.verts.forEach((vert, k) => {
      const sides = offsets[k].reduce((bits, d, a) => Math.abs(Math.abs(d) - 0.5) <= EDGE && d > 0 ? bits | 1 << a : bits, 0)
      vert.build = [level | (whole ? sides << 3 | 1 << 6 : 0), ring]
    })
  }
  return rings
}

function chunkOf(quads, name, level) {
  const solid = quads.filter(q => !q.blend), blended = quads.filter(q => q.blend)
  const layers = [{ start: 0, count: solid.length, blend: false }]
  if (blended.length) layers.push({ start: solid.length, count: blended.length, blend: true })
  return { quads: solid.concat(blended), header: { bin: level === null ? `${name}.bin` : `${name}.${level}.bin`, quads: quads.length, layers } }
}

export async function bake(name, { download = true, around = null, cull = true, levels = null } = {}) {
  if (!/^[a-z0-9_-]+$/.test(name ?? "")) throw new Error("bake: pass a file name made of a-z, 0-9, _ and -")
  const build = useBuild(), assets = usePacks().assets.value
  const structure = ensureRaw(build.current.value)
  if (!structure || !assets || build.state.building) throw new Error("bake: load a structure in the viewer first")
  const lib = await loadLibrary()
  const blocks = sceneBlocks(structure, cull)
  const { min, max } = blockBounds(blocks)
  const anchor = structure.anchor ?? [0, 0, 0]
  const centre = around ? anchor.map((c, a) => c + around[a]) : [(min[0] + max[0] + 1) / 2, min[1], (min[2] + max[2] + 1) / 2]
  const lighting = { dimension: build.lightDim(), daytime: DEFAULT_DAYTIME }
  const handle = await lib.createScene(assets, blocks, { optimize: false, animate: false, randomOffset: true, origin: structure.worldOrigin ?? [0, 0, 0], lighting })
  try {
    for (const entity of structure.entities ?? []) {
      const cushion = cushionOf(entity)
      if (!cushion) continue
      const group = new THREE.Group()
      group.position.set(entity.pos[0] * 16 - 8, entity.pos[1] * 16, entity.pos[2] * 16 - 8)
      handle.group.add(group)
      await lib.loadModel(assets, await lib.resolveModelData(assets, cushion), { parent: group, display: {}, lighting: Object.assign({ light: handle.light }, lighting), animate: false })
    }
    const { quads, tiles } = collectQuads(handle.group, handle.light, centre)
    if (!quads.length) throw new Error("bake: the loaded structure has no visible faces")
    const rings = levels ? tagLevels(quads, levels, anchor, centre) : null
    const atlasSize = layoutAtlas(tiles)
    const chunks = levels ? levels.map((keys, level) => chunkOf(quads.filter(q => q.level === level), name, level)) : [chunkOf(quads, name, null)]
    const header = { version: VERSION, size: max.map((c, a) => c - min[a] + 1), scale: SCALE, atlas: `${name}.png`, atlasSize, quads: quads.length, chunks: chunks.map(chunk => chunk.header), animations: animations(tiles, atlasSize) }
    if (levels) {
      header.grid = centre.map(c => ((0.5 - c) % 1 + 1) % 1)
      header.levels = levels.map((keys, level) => ({ blocks: keys.length, rings: rings[level] }))
    }
    const files = [{ name: `${name}.json`, blob: new Blob([JSON.stringify(header)], { type: "application/json" }) }]
    for (const chunk of chunks) files.push({ name: chunk.header.bin, blob: new Blob([packVertices(chunk.quads, atlasSize)], { type: "application/octet-stream" }) })
    files.push({ name: `${name}.png`, blob: await drawAtlas(tiles, atlasSize) })
    if (download) for (const file of files) saveBlob(file.blob, file.name)
    return { header, textures: tiles.length, files }
  } finally {
    handle.dispose()
  }
}
