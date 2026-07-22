// Renders public/og.png (1200x630): a generated village in rolling grassy
// terrain with trees, isometric, cropped so the scene fills the whole
// frame. Static output: edge runtimes can't run the native gl renderer, so
// this runs locally and the image is committed.
//
// Usage:  node tools/og-image.js [version]
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as lib from "block-model-renderer"
import * as THREE from "three"
import sharp from "sharp"
import { readZip, unzipEntry } from "./builtin/zip.js"
import { prepareVersion, prepareClient } from "./builtin/common.js"
import { readStructure } from "../src/nbt.js"
import { runJigsaw } from "../src/jigsaw.js"
import { mix, rnd } from "../src/transforms.js"
import { generateFeature } from "../src/features/index.js"

const SEED = 4
const START = "village/plains/town_centers/plains_fountain_01"
const TREES = ["minecraft/oak", "minecraft/birch", "minecraft/oak", "minecraft/fancy_oak"]
const TREE_COUNT = 180
const ZOOM = 0.58
const DAYTIME = 12300
const HILL_AMP = 10

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const cache = path.join(here, "builtin/.cache")
const t0 = performance.now()
const log = (...a) => console.log(`[og ${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...a)

// sharp's SVG text goes through fontconfig, and on windows the native lib
// only sees FONTCONFIG_PATH if it was set at process start: re-exec once
if (!process.env.FONTCONFIG_PATH) {
  const fcDir = path.join(cache, "fontconfig")
  fs.mkdirSync(fcDir, { recursive: true })
  fs.writeFileSync(path.join(fcDir, "fonts.conf"), `<?xml version="1.0"?>
<fontconfig>
  <dir>${path.join(here, "fonts").replaceAll("\\", "/")}</dir>
  <cachedir>${path.join(fcDir, "fc-cache").replaceAll("\\", "/")}</cachedir>
</fontconfig>`)
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, FONTCONFIG_PATH: fcDir } })
  process.exit(r.status ?? 1)
}

const { id, verDir } = await prepareVersion(cache, process.argv[2], log)
log("version:", id, "seed:", SEED)

const jar = fs.readFileSync(await prepareClient(verDir, id, log))
const jarZip = readZip(jar)
const assets = await lib.prepareAssets([jar], { cache: true })
const td = new TextDecoder()

const nsPath = ref => ref.includes(":") ? ref.replace(":", "/") : "minecraft/" + ref
const loadStruct = async ref => {
  const e = jarZip.get(`data/${nsPath(ref).replace("/", "/structure/")}.nbt`)
  return e ? readStructure(Buffer.from(unzipEntry(e))) : null
}
const loadPool = async ref => {
  const e = jarZip.get(`data/${nsPath(ref).replace("/", "/worldgen/template_pool/")}.json`)
  return e ? JSON.parse(td.decode(unzipEntry(e))) : null
}
const featureJson = rel => JSON.parse(fs.readFileSync(path.join(root, "bundled/features/data", rel.replace("/", "/worldgen/feature/") + ".json")))

log("generating village…")
const start = await loadStruct(START)
const { structure: village, pieces } = await runJigsaw(start, {
  loadStruct, loadPool, maxDepth: 6, maxPieces: 48, maxRadius: 80,
  levelSeed: l => mix(SEED, l), keepJigsaws: false
})
log(`${pieces} pieces, ${village.size.join("x")}`)

const AIR = /(^|:)(air|cave_air|void_air|structure_void|jigsaw|structure_block)$/
const world = new Map()
const wkey = (x, y, z) => x + "," + y + "," + z

// terrain surface at the village origin level, so paths sit flush in the
// ground like the game carves them
const groundY = village.anchor[1]
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
for (const b of village.blocks) {
  if (AIR.test(village.palette[b.state]?.Name ?? "")) continue
  minX = Math.min(minX, b.pos[0]); maxX = Math.max(maxX, b.pos[0])
  minZ = Math.min(minZ, b.pos[2]); maxZ = Math.max(maxZ, b.pos[2])
}
const vcx = Math.round((minX + maxX) / 2), vcz = Math.round((minZ + maxZ) / 2)

// the crop frames the village, so size the terrain from the frame: enough
// ground past the frustum in every direction that no background shows
const ASPECT = 1200 / 630
const projHalfW = (maxX - minX + maxZ - minZ + 2) * 16 / (2 * Math.SQRT2)
const boxTop = (village.size[1] + HILL_AMP) * 16
const projHalfH = projHalfW * Math.sin(Math.PI / 6) + boxTop * Math.cos(Math.PI / 6) / 2
const v = Math.max(projHalfH, projHalfW / ASPECT) * ZOOM
const EXT = Math.ceil(v * 3.5 / 16)
log(`terrain extent: ±${EXT} blocks`)

// rolling hills: seeded value noise, flattened around the village so the
// pieces still meet the ground
const cellSize = 12
const lattice = new Map()
function latticeValue(i, j) {
  const k = i + "," + j
  if (!lattice.has(k)) lattice.set(k, rnd(mix(mix(SEED, i * 7349 + 1), j * 911 + 2))())
  return lattice.get(k)
}
const fade = t => t * t * (3 - 2 * t)
function noise(x, z) {
  const fx = x / cellSize, fz = z / cellSize
  const i = Math.floor(fx), j = Math.floor(fz)
  const tx = fade(fx - i), tz = fade(fz - j)
  const a = latticeValue(i, j), b = latticeValue(i + 1, j)
  const c = latticeValue(i, j + 1), d = latticeValue(i + 1, j + 1)
  return a + (b - a) * tx + (c - a + (a - b + d - c) * tx) * tz
}
function heightAt(x, z) {
  const dx = Math.max(0, Math.abs(x - vcx) - (maxX - minX) / 2 - 6)
  const dz = Math.max(0, Math.abs(z - vcz) - (maxZ - minZ) / 2 - 6)
  const f = fade(Math.min(1, Math.max(dx, dz) / 22))
  const n = noise(x, z) * 0.72 + noise(x * 2.7 + 191, z * 2.7 - 67) * 0.28
  return Math.round(n * HILL_AMP * f)
}

const GRASS = { Name: "minecraft:grass_block", Properties: { snowy: "false" } }
const DIRT = { Name: "minecraft:dirt" }
const H = new Map()
for (let x = vcx - EXT; x <= vcx + EXT; x++) {
  for (let z = vcz - EXT; z <= vcz + EXT; z++) {
    H.set(x + "," + z, heightAt(x, z))
  }
}
for (let x = vcx - EXT; x <= vcx + EXT; x++) {
  for (let z = vcz - EXT; z <= vcz + EXT; z++) {
    const h = H.get(x + "," + z)
    world.set(wkey(x, groundY + h, z), GRASS)
    const floor = Math.min(
      H.get((x - 1) + "," + z) ?? h, H.get((x + 1) + "," + z) ?? h,
      H.get(x + "," + (z - 1)) ?? h, H.get(x + "," + (z + 1)) ?? h
    )
    for (let y = h - 1; y >= floor; y--) world.set(wkey(x, groundY + y, z), DIRT)
  }
}

for (const b of village.blocks) {
  const e = village.palette[b.state]
  if (!e?.Name || AIR.test(e.Name)) continue
  world.set(wkey(...b.pos), e)
}

const surfaceY = (x, z) => groundY + (H.get(x + "," + z) ?? 0)
const grassTop = (x, z) => {
  const y = surfaceY(x, z)
  return world.get(wkey(x, y, z)) === GRASS && !world.has(wkey(x, y + 1, z)) ? y : null
}

// trees, thicker toward the edges, kept off the buildings and each other
const trand = rnd(mix(SEED, 777))
const treeSpots = []
let planted = 0
for (let attempt = 0; attempt < 9000 && planted < TREE_COUNT; attempt++) {
  const x = vcx - EXT + 2 + Math.floor(trand() * (EXT * 2 - 4))
  const z = vcz - EXT + 2 + Math.floor(trand() * (EXT * 2 - 4))
  if (treeSpots.some(([sx, sz]) => Math.abs(sx - x) < 4 && Math.abs(sz - z) < 4)) continue
  // sparse meadow near the village thickening into forest at the edges
  const ex = Math.max(0, Math.abs(x - vcx) - (maxX - minX) / 2)
  const ez = Math.max(0, Math.abs(z - vcz) - (maxZ - minZ) / 2)
  const f = Math.min(1, Math.max(ex, ez) / (EXT * 0.7))
  if (trand() > 0.08 + 0.92 * f * f) continue
  const gy = grassTop(x, z)
  if (gy === null) continue
  let clear = true
  for (let dx = -2; dx <= 2 && clear; dx++) for (let dz = -2; dz <= 2 && clear; dz++) for (let dy = 1; dy <= 7 && clear; dy++) {
    if (world.has(wkey(x + dx, gy + dy, z + dz))) clear = false
  }
  if (!clear) continue
  const rel = TREES[planted % TREES.length]
  const tree = await generateFeature(rel, featureJson(rel), rnd(mix(SEED, 1000 + attempt)), null)
  // trees carry their below-trunk dirt at y 0, so the trunk lands at gy + 1
  for (const b of tree.blocks) {
    const k = wkey(x + b.pos[0] - tree.anchor[0], gy + b.pos[1], z + b.pos[2] - tree.anchor[2])
    if (!world.has(k)) world.set(k, tree.palette[b.state])
  }
  treeSpots.push([x, z])
  planted++
}

// ground cover: short grass with the odd flower
const FLOWERS = ["minecraft:poppy", "minecraft:dandelion", "minecraft:oxeye_daisy", "minecraft:cornflower"]
let cover = 0
for (let x = vcx - EXT; x <= vcx + EXT; x++) {
  for (let z = vcz - EXT; z <= vcz + EXT; z++) {
    const gy = grassTop(x, z)
    if (gy === null) continue
    const roll = trand()
    if (roll < 0.11) world.set(wkey(x, gy + 1, z), { Name: "minecraft:short_grass" })
    else if (roll < 0.125) world.set(wkey(x, gy + 1, z), { Name: FLOWERS[Math.floor(trand() * FLOWERS.length)] })
    else continue
    cover++
  }
}
log(`${planted} trees, ${cover} ground cover, ${world.size} blocks`)

// world lighting: sky + block light flooded over the whole scene, like the viewer
log("computing light…")
const lightBlocks = []
for (const [k, e] of world) {
  const [x, y, z] = k.split(",").map(Number)
  lightBlocks.push({ id: e.Name, properties: e.Properties ?? {}, pos: [x, y, z] })
}
const sceneLight = await lib.computeSceneLight(lightBlocks, { assets })
const LIGHT = { light: sceneLight, daytime: DAYTIME }

const { scene, camera } = lib.makeModelScene()

// seeded rotations: 16 probe seeds per state, deduped into one template per
// distinct pick, chosen per block with a vanilla-style position hash
const RSEEDS = Array.from({ length: 16 }, (_, i) => Math.imul(i + 1, 0x9E3779B1) >>> 0)
const templates = new Map()
const stateBuckets = new Map()
async function buckets(e) {
  const stateKey = e.Name + "|" + JSON.stringify(e.Properties ?? null)
  if (stateBuckets.has(stateKey)) return stateBuckets.get(stateKey)
  const byModels = new Map()
  const keys = []
  for (const seed of RSEEDS) {
    let tk = null
    try {
      const models = await lib.parseBlockstate(assets, e.Name, { data: e.Properties ?? {}, ignoreAtlases: true, seed })
      const mk = JSON.stringify(models)
      tk = byModels.get(mk)
      if (tk === undefined) {
        tk = stateKey + "#" + byModels.size
        byModels.set(mk, tk)
        let g = new THREE.Group()
        for (const model of models) {
          await lib.loadModel(g, assets, await lib.resolveModelData(assets, model), { display: {}, lighting: LIGHT, animate: false })
        }
        if (!g.children.length) g = null
        templates.set(tk, g)
      }
    } catch {}
    keys.push(tk)
  }
  const arr = byModels.size > 1 ? keys : [keys[0]]
  stateBuckets.set(stateKey, arr)
  return arr
}

function posHash(x, y, z) {
  const h = Math.imul(x, 3129871) ^ Math.imul(z, 116129781) ^ y
  return (Math.imul(Math.imul(h, h), 42317861) + Math.imul(h, 11) | 0) >>> 16
}

// fluid surfaces: shape each water/lava cell from its 26 neighbours so it sits
// at the right height with hidden shared faces, deduped by shape like the viewer
const FLUID_DIRS = []
for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
  let key = !dx && !dy && !dz ? "self" : dy === 1 ? "up" : dy === -1 ? "down" : ""
  if (dx || dy || dz) {
    if (dz === -1) key += (key ? "_" : "") + "north"
    else if (dz === 1) key += (key ? "_" : "") + "south"
    if (dx === -1) key += (key ? "_" : "") + "west"
    else if (dx === 1) key += (key ? "_" : "") + "east"
  }
  FLUID_DIRS.push([key, dx, dy, dz])
}
const fluidTemplates = new Map()
async function fluidTemplate(e, type, x, y, z) {
  const neighbors = {}
  for (const [key, dx, dy, dz] of FLUID_DIRS) {
    const n = world.get(wkey(x + dx, y + dy, z + dz))
    if (n?.Name) neighbors[key] = { id: n.Name, ...(n.Properties ?? {}) }
  }
  const h = await lib.fluidHeights(assets, type, neighbors)
  const ov = h.overlay ? (h.overlay.north ? "n" : "") + (h.overlay.south ? "s" : "") + (h.overlay.east ? "e" : "") + (h.overlay.west ? "w" : "") : ""
  const sm = h.same ? (h.same.north ? "n" : "") + (h.same.south ? "s" : "") + (h.same.east ? "e" : "") + (h.same.west ? "w" : "") + (h.same.up ? "u" : "") + (h.same.down ? "d" : "") : ""
  const key = `${e.Name}|${JSON.stringify(e.Properties ?? null)}|${h.nw.toFixed(3)},${h.ne.toFixed(3)},${h.sw.toFixed(3)},${h.se.toFixed(3)}|${h.full ? 1 : 0}|${h.angle == null ? "" : h.angle.toFixed(2)}|${ov}|${sm}`
  let t = fluidTemplates.get(key)
  if (t === undefined) {
    let g = new THREE.Group()
    try {
      for (const model of await lib.parseBlockstate(assets, e.Name, { data: e.Properties ?? {}, ignoreAtlases: true })) {
        await lib.loadModel(g, assets, await lib.resolveModelData(assets, model), { display: {}, lighting: LIGHT, animate: false, fluidHeights: h })
      }
    } catch {}
    t = g.children.length ? g : null
    fluidTemplates.set(key, t)
  }
  return t
}

// culled + merged like the viewer: buried faces drop and draw calls collapse,
// which is what keeps the render fast
log("building scene…")
const DIRS = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] }
const cullMemo = new Map()
const placements = []
let placed = 0
for (const [k, e] of world) {
  const [x, y, z] = k.split(",").map(Number)
  const type = lib.fluidTypeOf(e.Name, e.Properties)
  let t
  if (type) {
    t = await fluidTemplate(e, type, x, y, z)
  } else {
    const keys = await buckets(e)
    t = templates.get(keys.length > 1 ? keys[posHash(x, y, z) & 15] : keys[0])
  }
  if (!t) continue
  const nEntries = Object.entries(DIRS).map(([dir, [dx, dy, dz]]) => [dir, world.get(wkey(x + dx, y + dy, z + dz))])
  const mkey = e.Name + "|" + JSON.stringify(e.Properties ?? null) + "|" +
    nEntries.map(([, n]) => n ? n.Name + JSON.stringify(n.Properties ?? null) : "").join(",")
  let cull = cullMemo.get(mkey)
  if (cull === undefined) {
    const neighbors = {}
    for (const [dir, n] of nEntries) if (n) neighbors[dir] = { id: n.Name, ...(n.Properties ?? {}) }
    cull = await lib.getCullFaces({ id: e.Name, blockstates: e.Properties ?? {}, neighbors, assets })
    cullMemo.set(mkey, cull)
  }
  placements.push({ pos: [x, y, z], group: t, cull })
  if (++placed % 10000 === 0) log(`culled ${placed}/${world.size}`)
}
log(`optimising ${placements.length} placements, ${templates.size} templates`)
const opt = await lib.optimizeScene(placements)
sceneLight.setOffset(opt.group.position)
scene.add(opt.group)
log(`${opt.drawCalls} draw calls, ${opt.tris} tris`)

// isometric from the north-west (fronts face north), 30 degree pitch,
// framed on the village so the terrain runs past every frame edge
const center = new THREE.Vector3(vcx * 16, (groundY + village.size[1] / 2) * 16, vcz * 16)
// nudged up a little so the village band sits lower in the frame
center.y += v * 0.45
const dist = EXT * 16 * 3
camera.position.set(center.x - dist, center.y + dist * Math.SQRT2 * Math.tan(Math.PI / 6), center.z - dist)
camera.lookAt(center)
camera.left = -v
camera.right = v
camera.top = v
camera.bottom = -v
camera.near = 0.1
camera.far = dist * 4
camera.zoom = 1
camera.fitAspect = true
camera.updateProjectionMatrix()

log("rendering…")
lib.sortTranslucent(scene, camera)
// 2x supersample is the antialiasing: headless-gl has no MSAA, and the
// downscale smooths edges and minified block textures alike
const render = await lib.renderModelScene(scene, camera, { width: 2400, height: 1260, background: "#16161a" })

const overlay = Buffer.from(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="5"/>
    <feOffset dy="3" result="o"/>
    <feFlood flood-color="#0b0b0e" flood-opacity="0.8"/>
    <feComposite in2="o" operator="in"/>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <g filter="url(#shadow)" text-anchor="end" font-family="Gabarito">
    <text x="1152" y="538" font-size="84" font-weight="700" fill="#f2f2f5">Structure Viewer</text>
    <text x="1152" y="588" font-size="36" fill="#d6d6de">Minecraft structures &amp; worldgen in 3D</text>
  </g>
</svg>`)
await sharp(render).resize(1200, 630).composite([{ input: overlay }]).png().toFile(path.join(root, "public/og.png"))
log("wrote public/og.png")
