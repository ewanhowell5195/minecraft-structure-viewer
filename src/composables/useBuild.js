import { reactive, readonly, shallowRef, watch } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useScene } from "./useScene.js"
import { useSlicers } from "./useSlicers.js"
import { useLock } from "./useLock.js"
import { yieldTask } from "../yield.js"
import { exportScene } from "../export.js"
import { makeSignTexts, plainText } from "../signs.js"
import { JIGSAW, parseState } from "../transforms.js"
import { isInspectable, readTrialSpawnerConfig } from "../loot.js"
import { getFont, measure, drawText } from "../mcfont.js"
import { drawFakeMap, randomiseFakeMapWorld } from "../mapgen.js"

const packs = usePacks()
const sceneApi = useScene()
const { lock } = useLock()

const AIR = /(^|:)(air|cave_air|void_air|structure_void)$/

const LEGACY_RENAMES = {
  grass: "short_grass",
  grass_path: "dirt_path",
  chain: "iron_chain",
  sign: "oak_sign",
  wall_sign: "oak_wall_sign"
}

const SB = /(^|:)structure_block$/
function stripStructureBlocks(structure) {
  function isTech(b) {
    const n = structure.palette[b.state]?.Name || ""
    return JIGSAW.test(n) || SB.test(n)
  }
  if (!structure.blocks.some(isTech)) return structure
  const palette = structure.palette.slice()
  const idx = new Map()
  function stateFor(e) {
    const key = e.Name + "|" + JSON.stringify(e.Properties ?? null)
    let i = idx.get(key)
    if (i === undefined) {
      i = palette.findIndex(pe => pe.Name === e.Name && sameProps(pe.Properties, e.Properties))
      if (i < 0) { i = palette.length; palette.push(e) }
      idx.set(key, i)
    }
    return i
  }
  const blocks = []
  for (const b of structure.blocks) {
    if (!isTech(b)) { blocks.push(b); continue }
    if (JIGSAW.test(structure.palette[b.state].Name)) {
      const fs = parseState(typeof b.nbt?.final_state === "string" ? b.nbt.final_state : "")
      if (!AIR.test(fs.Name)) blocks.push({ pos: b.pos, state: stateFor(fs) })
    }
  }
  return { ...structure, palette, blocks }
}

// walls went from boolean north/south/east/west to none/low/tall in 1.16
function fixLegacyProps(name, props) {
  if (!props) return props
  if (name.endsWith("_wall")) {
    const p = { ...props }
    for (const d of ["north", "south", "east", "west"]) {
      if (p[d] === "true") p[d] = "low"
      else if (p[d] === "false") p[d] = "none"
    }
    return p
  }
  return props
}

async function remapLoaderStates(structure, lib, assets) {
  const loaders = lib.ModelLoader?.list() ?? []
  if (!loaders.length) return
  const byPos = new Map()
  for (const b of structure.blocks) byPos.set(b.pos.join(","), b)
  const matched = new Map() // stateIdx -> resolved models or null
  async function matchedModels(stateIdx) {
    if (matched.has(stateIdx)) return matched.get(stateIdx)
    let result = null
    const e = structure.palette[stateIdx]
    if (e?.Name && !e.__fluidKey) {
      try {
        const models = await lib.parseBlockstate(assets, e.Name, { data: e.Properties ?? {}, ignoreAtlases: true })
        const datas = []
        for (const m of models) datas.push(await lib.resolveModelData(assets, m))
        if (datas.some(d => loaders.some(l => l.match?.(d)))) result = datas
      } catch {}
    }
    matched.set(stateIdx, result)
    return result
  }
  const byKey = new Map()
  structure.palette.forEach((e, i) => { if (e?.__loaderKey) byKey.set(e.__loaderKey, i) })
  for (const b of structure.blocks) {
    const datas = await matchedModels(b.state)
    if (!datas) continue
    const e = structure.palette[b.state]
    const [bx, by, bz] = b.pos
    const neighbors = {}
    for (const [dir, dx, dy, dz] of [["north", 0, 0, -1], ["south", 0, 0, 1], ["west", -1, 0, 0], ["east", 1, 0, 0], ["up", 0, 1, 0], ["down", 0, -1, 0]]) {
      const nb = byPos.get((bx + dx) + "," + (by + dy) + "," + (bz + dz))
      const ne = nb && structure.palette[nb.state]
      if (ne?.Name) neighbors[dir] = { id: ne.Name, ...(ne.Properties ?? {}) }
    }
    const block = { id: e.Name, properties: e.Properties ?? {}, neighbors, nbt: b.nbt ?? null }
    const variant = datas.map(d => lib.ModelLoader.variantKey(d, block) ?? "").join("/")
    const key = `${b.state}|${variant}|${JSON.stringify(b.nbt ?? null)}`
    let idx = byKey.get(key)
    if (idx === undefined) {
      idx = structure.palette.length
      const entry = { Name: e.Name }
      if (e.Properties) entry.Properties = e.Properties
      entry.__block = block
      entry.__loaderKey = key
      structure.palette.push(entry)
      byKey.set(key, idx)
    }
    b.state = idx
  }
}

export const NOON = 6000

const state = reactive({
  lighting: "world",
  fullbright: false,
  daytime: NOON,
  hideStructureBlocks: localStorage.getItem("hideStructureBlocks") !== "false",
  hasStructureBlocks: false,
  building: false,
  status: "",
  progress: null, // { phase: "build" | "optimise", done, total } while working
  info: null,
  warn: null // { seconds } while a slow-build confirmation is showing
})

const WARN_MS = 10000
const PERF_KEY = "buildPerf2" // v2: rates are per non-air block

function loadPerf() {
  try {
    const p = JSON.parse(localStorage.getItem(PERF_KEY))
    return typeof p?.b === "number" && typeof p?.o === "number" ? p : null
  } catch { return null }
}

function savePerf(b, o) {
  const prev = loadPerf()
  const mix = (a, x) => a == null ? x : a * 0.5 + x * 0.5
  try { localStorage.setItem(PERF_KEY, JSON.stringify({ b: mix(prev?.b, b), o: mix(prev?.o, o) })) } catch {}
}

let warnResolve = null
function askWarn(ms) {
  state.warn = { seconds: Math.max(Math.round(ms / 1000), 1) }
  return new Promise(r => { warnResolve = r })
}

const RESTORE_BLOCKS = 24000
let restoreGate = false, restoreGateAsked = false
function setRestoreGate(on) {
  restoreGate = on
  if (on) restoreGateAsked = false
}
async function restoreGateCheck(blocks, selection = false, approx = false) {
  if (!restoreGate || restoreGateAsked || blocks <= RESTORE_BLOCKS) return true
  restoreGateAsked = true
  state.warn = { blocks, selection, approx }
  return new Promise(r => { warnResolve = r })
}

function answerWarn(ok) {
  state.warn = null
  warnResolve?.(ok)
  warnResolve = null
}

// seeded into template userData so the library shares one live uniform: daytime changes re-light with no rebuild
const daytimeUniform = { value: NOON }
let clockTimer = null
watch(() => state.daytime, v => {
  daytimeUniform.value = v
  if (sceneHandle?.group.userData.daytime) sceneHandle.group.userData.daytime.value = v
  relightFakeMaps()
  clearTimeout(clockTimer)
  clockTimer = setTimeout(updateClocks, 150)
})

let savedDaytime = NOON
watch(() => state.fullbright, on => {
  if (on) {
    savedDaytime = state.daytime
    state.daytime = NOON
  } else {
    state.daytime = savedDaytime
  }
})

const OPENABLE = /(^|:)([a-z_]+_)?(door|trapdoor|fence_gate)$/
const isDoorName = name => /(^|:)([a-z_]+_)?door$/.test(name) && !/trapdoor$/.test(name)
const isOpenable = e => !!(e?.Properties && "open" in e.Properties && OPENABLE.test(e.Name || ""))
function sameProps(a, b) {
  const ka = Object.keys(a || {})
  if (ka.length !== Object.keys(b || {}).length) return false
  return ka.every(k => a[k] === b[k])
}

const current = shallowRef(null)
let source = null // the structure as loaded/combined; current may be a display strip of it
let root = null
let sceneHandle = null
let inputIdxOf = null // structure block index -> createScene input index, -1 for door/loader/air
let nonSolidPalette = new Set() // handle palette indices with all-plane models
if (typeof window !== "undefined") window.__vroot = () => root
let animator = null
let templates = null
let nonSolid = new Set()
let sceneLight = null
let entityMarkers = [] // root-local coords
let markerTextures = []
let doorByCell = new Map()
let blockMap = null, blockMapFor = null

// the full build kept hidden during slice display, so slicers can swap back without a rebuild
let fullBundle = null
let rootSliced = false

function stateWithOpen(structure, stateIdx, open) {
  const e = structure.palette[stateIdx], props = { ...e.Properties, open }
  let idx = structure.palette.findIndex(pe => pe.Name === e.Name && sameProps(pe.Properties, props))
  if (idx < 0) {
    idx = structure.palette.length
    structure.palette.push({ Name: e.Name, Properties: props })
  }
  return idx
}

function cellIndex() {
  const structure = current.value
  if (blockMapFor !== structure) {
    blockMap = new Map()
    structure.blocks.forEach((b, i) => blockMap.set(b.pos[0] + "," + b.pos[1] + "," + b.pos[2], i))
    blockMapFor = structure
  }
  return blockMap
}

// geometry is centred on i*16: round, not floor, else every block straddles two cells
const cellOf = (wx, wy, wz) => [Math.round((wx - root.position.x) / 16), Math.round((wy - root.position.y) / 16), Math.round((wz - root.position.z) / 16)]

function blockAt(wx, wy, wz) {
  const structure = current.value
  if (!structure || !root) return null
  const [bx, by, bz] = cellOf(wx, wy, wz)
  const i = cellIndex().get(bx + "," + by + "," + bz)
  return i == null ? null : structure.palette[structure.blocks[i].state]
}

// rotation-only state variants share one unrotated template, the rotation folded
// into each instance matrix; hidden instances collapse to zero scale
let doorSlots = new Map() // canonKey -> { count, meshes: InstancedMesh[] }
let stateRender = new Map() // stateIdx -> { key, rot: Matrix4 }
let canonDoorTmpl = new Map() // canonKey -> template Group

const _dm = new THREE.Matrix4()
const _dzero = new THREE.Matrix4().makeScale(0, 0, 0)


function setDoorInstance(stateIdx, slot, pos, visible) {
  const r = stateRender.get(stateIdx)
  const s = r && doorSlots.get(r.key)
  if (!s) return
  for (const im of s.meshes) {
    if (visible) im.setMatrixAt(slot, _dm.makeTranslation(pos[0] * 16, pos[1] * 16, pos[2] * 16).multiply(r.rot).multiply(im.userData.baseMatrix))
    else im.setMatrixAt(slot, _dzero)
    im.instanceMatrix.needsUpdate = true
  }
}

function attachDoors(entries) {
  const structure = current.value
  doorByCell = new Map()
  doorSlots = new Map()
  if (!entries.length) return 0
  function slotFor(stateIdx) {
    const key = stateRender.get(stateIdx).key
    let s = doorSlots.get(key)
    if (!s) doorSlots.set(key, s = { count: 0, meshes: [] })
    return s.count++
  }
  for (const e of entries) {
    e.openSlot = slotFor(e.openIdx)
    e.closedSlot = slotFor(e.closedIdx)
  }
  let draws = 0
  for (const [key, s] of doorSlots) {
    const tmpl = canonDoorTmpl.get(key)
    if (!tmpl) continue
    tmpl.updateMatrixWorld(true)
    tmpl.traverse(o => {
      if (!o.isMesh) return
      // the library shader handles USE_INSTANCING, so materials are shared as-is
      const im = new THREE.InstancedMesh(o.geometry, o.material, s.count)
      im.userData.baseMatrix = o.matrixWorld.clone()
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      // geometry bounds would frustum-cull the spread instances wrongly
      im.frustumCulled = false
      for (let i = 0; i < s.count; i++) im.setMatrixAt(i, _dzero)
      root.add(im)
      s.meshes.push(im)
      draws++
    })
  }
  for (const e of entries) {
    const open = structure.palette[e.b.state].Properties.open === "true"
    setDoorInstance(e.openIdx, e.openSlot, e.b.pos, open)
    setDoorInstance(e.closedIdx, e.closedSlot, e.b.pos, !open)
    doorByCell.set(e.b.pos.join(","), { b: e.b, openIdx: e.openIdx, closedIdx: e.closedIdx, openSlot: e.openSlot, closedSlot: e.closedSlot, pair: null })
  }
  for (const reg of doorByCell.values()) {
    if (!isDoorName(structure.palette[reg.b.state].Name)) continue
    const [x, y, z] = reg.b.pos
    reg.pair = doorByCell.get(x + "," + (y + 1) + "," + z) || doorByCell.get(x + "," + (y - 1) + "," + z) || null
  }
  return draws
}

// yaw snaps to the nearest cardinal like the game's Direction.fromYRot
const ENTITY_BOX = 14

// egg-less mobs borrow a lookalike's egg
const EGG_ALIASES = { giant: "zombie", evoker_fangs: "evoker", llama_spit: "llama", wither_skull: "wither" }

async function entityMarkerTexture(lib, assets, name) {
  const c = document.createElement("canvas")
  c.width = 64
  c.height = 64
  let drawn = false
  if (name === "mannequin") {
    try {
      const buf = await lib.readFile("assets/minecraft/textures/entity/player/wide/steve.png", assets)
      if (buf) {
        const bmp = await createImageBitmap(new Blob([buf]))
        const ctx = c.getContext("2d")
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(bmp, 8, 8, 8, 8, 0, 0, 64, 64)
        ctx.drawImage(bmp, 40, 8, 8, 8, 0, 0, 64, 64)
        drawn = true
      }
    } catch {}
  }
  if (!drawn) for (const item of [name + "_spawn_egg", (EGG_ALIASES[name] ?? name) + "_spawn_egg", name]) {
    try {
      if (!await lib.readFile(`assets/minecraft/items/${item}.json`, assets)) continue
      await lib.renderItem({ id: item, assets, width: 64, height: 64, canvas: c })
      drawn = true
      break
    } catch {}
  }
  if (!drawn) {
    try {
      const font = await getFont()
      const ctx = c.getContext("2d")
      const s = 6
      const x = Math.round((64 - measure(font, "?") * s) / 2)
      const y = Math.round((64 - font.ch * s) / 2)
      drawText(ctx, font, "?", x + s, y + s, { scale: s, color: "#3f3f3f" })
      drawText(ctx, font, "?", x, y, { scale: s, color: "#ffffff" })
    } catch { return null }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.NearestFilter
  return tex
}

async function nameTagSprite(text) {
  try {
    const font = await getFont()
    const S = 4, pad = S * 2
    const c = document.createElement("canvas")
    c.width = Math.ceil(measure(font, text) * S) + pad * 2
    c.height = font.ch * S + pad * 2
    const ctx = c.getContext("2d")
    ctx.fillStyle = "#00000059"
    ctx.fillRect(0, 0, c.width, c.height)
    drawText(ctx, font, text, pad, pad, { scale: S })
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.magFilter = THREE.NearestFilter
    markerTextures.push(tex)
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }))
    const H = 5
    spr.scale.set(H * c.width / c.height, H, 1)
    return spr
  } catch { return null }
}

async function attachEntityTag(nbt, wx, topY, wz) {
  const label = plainText(nbt?.CustomName ?? "")
  if (!label) return 0
  const tag = await nameTagSprite(label)
  if (!tag) return 0
  tag.position.set(wx, topY + 3 + tag.scale.y / 2, wz)
  root.add(tag)
  return 1
}

const FRAME = /(^|:)(glow_)?item_frame$/
const FACING6 = ["down", "up", "north", "south", "west", "east"]
const FRAME_ROT = { south: [0, Math.PI], west: [0, Math.PI / 2], east: [0, -Math.PI / 2], up: [-Math.PI / 2, Math.PI], down: [Math.PI / 2, Math.PI] }
const MAP_OFF = 6.85
const MAP_DIR = { north: [0, 0, 1], south: [0, 0, -1], east: [-1, 0, 0], west: [1, 0, 0], up: [0, -1, 0], down: [0, 1, 0] }

function placeFakeMap(f) {
  const d = MAP_DIR[f.facing]
  f.mesh.position.set(f.bx * 16 + d[0] * f.off, f.by * 16 + d[1] * f.off, f.bz * 16 + d[2] * f.off)
}

let fakeMaps = []
const FALLBACK_ENV = { skyLightFactor: "overworld", skyLightColor: 0x7A7AFF, ambientColor: 0x0A0A0A, blockLightTint: 0xFFD88C }
let mapLightEnv = FALLBACK_ENV
const hexRGB = v => [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]

// mirrors the library shader's world lighting so the basic-material map planes
// match; no directional shade, the game draws maps with the lightmap only
function relightFakeMaps() {
  const env = mapLightEnv ?? FALLBACK_ENV
  const amb = hexRGB(env.ambientColor)
  const skyTint = hexRGB(env.skyLightColor)
  const blockTint = hexRGB(env.blockLightTint)
  for (const f of fakeMaps) {
    let r = 1, g = 1, b = 1
    if (state.lighting === "world" && f.light) {
      let skyFactor, sc
      if (env.skyLightFactor === "overworld") {
        const td = ((state.daytime - 730) % 24000 + 24000) % 24000 + 730
        if (td < 11270) { skyFactor = 1; sc = [1, 1, 1] }
        else if (td < 13140) { const k = (td - 11270) / 1870; skyFactor = 1 + (0.24 - 1) * k; sc = skyTint.map(c => 1 + (c - 1) * k) }
        else if (td < 22860) { skyFactor = 0.24; sc = skyTint }
        else { const k = (td - 22860) / 1870; skyFactor = 0.24 + (1 - 0.24) * k; sc = skyTint.map(c => c + (1 - c) * k) }
      } else {
        skyFactor = env.skyLightFactor
        sc = skyTint
      }
      const bl = f.light.block / 15, sl = f.light.sky / 15
      const skyB = sl / (4 - 3 * sl) * skyFactor
      const blockB = bl / (4 - 3 * bl) * 1.4
      const t = 0.9 * (2 * bl - 1) * (2 * bl - 1)
      const bc = blockTint.map(c => c + (1 - c) * t)
      r = Math.min(1, amb[0] + sc[0] * skyB + bc[0] * blockB)
      g = Math.min(1, amb[1] + sc[1] * skyB + bc[1] * blockB)
      b = Math.min(1, amb[2] + sc[2] * skyB + bc[2] * blockB)
      const mx = Math.max(r, g, b)
      if (mx > 0) {
        const inv = 1 - mx
        const scale = (1 - inv * inv * inv * inv) / mx
        r += (r * scale - r) * 0.5
        g += (g * scale - g) * 0.5
        b += (b * scale - b) * 0.5
      }
    }
    f.mesh.material.color.setRGB(r, g, b, THREE.SRGBColorSpace)
  }
}

function mapIdOf(it) {
  const n = Number(it?.components?.["minecraft:map_id"] ?? it?.tag?.map)
  return Number.isFinite(n) ? n : null
}

const MAP_GEO = {
  north: g => g.rotateY(Math.PI),
  south: g => g,
  east: g => g.rotateY(Math.PI / 2),
  west: g => g.rotateY(-Math.PI / 2),
  up: g => g.rotateX(-Math.PI / 2),
  down: g => g.rotateX(Math.PI / 2)
}
const COMPASS_2D = { south: 0, west: 1, north: 2, east: 3 }
function compassValue(facing, rot) {
  const corr = facing === "up" ? 90 : facing === "down" ? -90 : 0
  const yDeg = 180 + (COMPASS_2D[facing] ?? -1) * 90 + rot * 45 + corr
  return ((0.5 - yDeg / 360) % 1 + 1) % 1
}

function clockValue(daytime) {
  const u = (((daytime - 6000) / 24000) % 1 + 1) % 1
  let lo = 0, hi = 1
  for (let i = 0; i < 24; i++) {
    const s = (lo + hi) / 2
    const x = 3 * s * (1 - s) * (1 - s) * 0.362 + 3 * s * s * (1 - s) * 0.638 + s * s * s
    if (x < u) lo = s; else hi = s
  }
  const s = (lo + hi) / 2
  return 3 * s * (1 - s) * (1 - s) * 0.241 + 3 * s * s * (1 - s) * 0.759 + s * s * s
}

let clockFrames = []
let frameCtx = null
let buildDim = "overworld"
const lightingOpt = light => state.lighting === "world" ? { dimension: buildDim, light, daytime: state.daytime } : state.lighting
async function updateClocks() {
  if (!frameCtx || !clockFrames.length) return
  const { lib, assets } = frameCtx
  const v = clockValue(state.daytime)
  for (const cf of clockFrames) {
    if (!cf.holder) continue
    const disp = cf.disp ?? { type: "fallback", display: "fixed" }
    try {
      const tmp = new THREE.Group()
      tmp.userData.daytime = daytimeUniform
      for (const m of await lib.parseItemDefinition(assets, cf.item, { data: { ...cf.components, "minecraft:time": v }, display: disp, ignoreAtlases: true })) {
        const resolved = await lib.resolveModelData(assets, m)
        await lib.loadModel(tmp, assets, resolved, { display: disp, lighting: lightingOpt(sceneLight), animate: false, ...(cf.glow ? { emission: 15 } : null) })
      }
      cf.holder.clear()
      for (const c of Array.from(tmp.children)) cf.holder.add(c)
    } catch {}
  }
}

const MAP_SAMPLE = {
  north: (bx, by, bz, cx, cy) => [bx * 128 + 127 - cx, by * 128 + 127 - cy],
  south: (bx, by, bz, cx, cy) => [bx * 128 + cx, by * 128 + 127 - cy],
  east: (bx, by, bz, cx, cy) => [bz * 128 + 127 - cx, by * 128 + 127 - cy],
  west: (bx, by, bz, cx, cy) => [bz * 128 + cx, by * 128 + 127 - cy],
  up: (bx, by, bz, cx, cy) => [bx * 128 + cx, bz * 128 + cy],
  down: (bx, by, bz, cx, cy) => [bx * 128 + cx, bz * 128 + 127 - cy]
}

let mapArtCache = new Map()

async function makeFakeMap(bx, by, bz, facing, id, rot = 0, off = MAP_OFF) {
  let canvas = id == null ? null : mapArtCache.get(id)
  if (!canvas) {
    canvas = document.createElement("canvas")
    canvas.width = canvas.height = 128
    await drawFakeMap(canvas, (cx, cy) => MAP_SAMPLE[facing](bx, by, bz, cx, cy), id)
    if (id != null) mapArtCache.set(id, canvas)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.NearestFilter
  const geo = new THREE.PlaneGeometry(16, 16)
  const spin = (((rot % 4) + 4) % 4) * Math.PI / 2
  if (spin) geo.rotateZ(spin)
  MAP_GEO[facing](geo)
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }))
  const f = { mesh, tex, facing, bx, by, bz, off }
  placeFakeMap(f)
  f.light = sceneLight?.lightAt(bx, by, bz) ?? null
  fakeMaps.push(f)
  return f
}

async function attachEntities(structure, lib, assets) {
  let draws = 0
  const groupCache = new Map()
  const texCache = new Map()
  const sprites = []
  entityMarkers = []
  mapArtCache = new Map()
  fakeMaps = []
  randomiseFakeMapWorld()
  clockFrames = []
  frameCtx = { lib, assets }
  mapLightEnv = lib.LIGHT_DIMENSIONS?.[buildDim] ?? FALLBACK_ENV
  for (const e of structure.entities ?? []) {
    const id = e.nbt?.id
    if (typeof id !== "string") continue
    const [ns, name] = id.includes(":") ? id.split(":") : ["minecraft", id]
    const frame = FRAME.test(id)
    const glow = frame && id.includes("glow")
    const yaw = Number(e.nbt.Rotation?.[0] ?? 0)
    let facing = ["south", "west", "north", "east"][((Math.floor(yaw / 90 + 0.5) % 4) + 4) % 4]
    if (frame) facing = FACING6[Number(e.nbt.Facing ?? 3)] ?? facing
    const data = { facing }
    for (const [k, v] of Object.entries(e.nbt)) if (typeof v === "string" && k !== "id") data[k] = v
    const frameItem = frame ? e.nbt.Item?.id : null
    const frameMap = typeof frameItem === "string" && /(^|:)filled_map$/.test(frameItem)
    if (frameMap) data.map = "true"
    const invisible = frame && Number(e.nbt.Invisible ?? 0) === 1
    const key = id + "|" + JSON.stringify(data) + (frame ? `|${frameItem ?? ""}|${e.nbt.ItemRotation ?? 0}|${invisible ? 1 : 0}` : "")
    let template = groupCache.get(key)
    if (template === undefined) {
      template = null
      try {
        let blockId = null
        if (await lib.readFile(`assets/${ns}/blockstates/${name}.json`, assets)) blockId = id
        else {
          const coloured = `${typeof data.color === "string" ? data.color : "white"}_${name}`
          if (await lib.readFile(`assets/${ns}/blockstates/${coloured}.json`, assets)) blockId = `${ns}:${coloured}`
        }
        if (blockId) {
          const g = new THREE.Group()
          g.userData.daytime = daytimeUniform
          if (!invisible) {
            for (const model of await lib.parseBlockstate(assets, blockId, { data, ignoreAtlases: true })) {
              const data = await lib.resolveModelData(assets, model)
              await lib.loadModel(g, assets, data, { display: {}, lighting: lightingOpt(sceneLight), animate: false, ...(glow ? { emission: 15 } : null) })
            }
          }
          if (frame && frameItem && !frameMap) {
            try {
              const disp = { type: "fallback", display: "fixed" }
              const itemGroup = new THREE.Group()
              itemGroup.userData.daytime = daytimeUniform
              const itemData = { ...(e.nbt.Item.components ?? {}) }
              if (/(^|:)compass$/.test(frameItem)) itemData["minecraft:compass"] = compassValue(facing, Number(e.nbt.ItemRotation ?? 0))
              if (/(^|:)clock$/.test(frameItem)) itemData["minecraft:time"] = clockValue(state.daytime)
              for (const m of await lib.parseItemDefinition(assets, frameItem, { data: itemData, display: disp, ignoreAtlases: true })) {
                const resolved = await lib.resolveModelData(assets, m)
                await lib.loadModel(itemGroup, assets, resolved, { display: disp, lighting: lightingOpt(sceneLight), animate: false, ...(glow ? { emission: 15 } : null) })
              }
              if (itemGroup.children.length) {
                itemGroup.name = "frameItem"
                itemGroup.position.z = invisible ? 8 : 7
                itemGroup.scale.setScalar(0.5)
                itemGroup.rotation.z = Number(e.nbt.ItemRotation ?? 0) * Math.PI / 4
                g.add(itemGroup)
              }
            } catch {}
          }
          if (frame && FRAME_ROT[facing]) g.rotation.set(FRAME_ROT[facing][0], FRAME_ROT[facing][1], 0)
          if (g.children.length || invisible) template = g
        }
      } catch {}
      groupCache.set(key, template)
    }
    const wx = frame ? Math.floor(e.pos[0]) * 16 : e.pos[0] * 16 - 8
    const wy = frame ? Math.floor(e.pos[1]) * 16 : e.pos[1] * 16
    const wz = frame ? Math.floor(e.pos[2]) * 16 : e.pos[2] * 16 - 8
    if (template) {
      const g = groupCache.get(key).clone()
      g.position.set(wx, wy, wz)
      let box
      if (frame) {
        const half = frameMap ? 8 : 6
        box = new THREE.Box3(new THREE.Vector3(-half, -half, invisible ? 7.8 : 7), new THREE.Vector3(half, half, 8))
        g.updateMatrix()
        box.applyMatrix4(g.matrix)
      } else {
        box = new THREE.Box3().setFromObject(g)
      }
      root.add(g)
      g.traverse(o => { if (o.isMesh) draws++ })
      if (frameMap) {
        try {
          const fake = await makeFakeMap(Math.floor(e.pos[0]), Math.floor(e.pos[1]), Math.floor(e.pos[2]), facing, mapIdOf(e.nbt.Item), Number(e.nbt.ItemRotation ?? 0), invisible ? 7.85 : MAP_OFF)
          if (glow) fake.light = null
          root.add(fake.mesh)
          markerTextures.push(fake.tex)
          draws++
        } catch {}
      }
      if (frame && typeof frameItem === "string" && /(^|:)clock$/.test(frameItem)) {
        clockFrames.push({ holder: g.getObjectByName("frameItem"), item: frameItem, components: e.nbt.Item.components ?? {}, glow })
      }
      const noBox = box.isEmpty()
      entityMarkers.push(noBox
        ? { stack: [e], x: wx, y: wy - 8, z: wz }
        : { stack: [e], x: wx, y: box.min.y, z: wz, h: box.max.y - box.min.y, ...(frame ? { box } : null) })
      draws += await attachEntityTag(e.nbt, wx, noBox ? wy + 8 : box.max.y, wz)
      continue
    }
    sprites.push({ e, name, wx, wy, wz })
  }

  const clusters = []
  const touches = (a, b) => Math.abs(a.wx - b.wx) < ENTITY_BOX && Math.abs(a.wy - b.wy) < ENTITY_BOX && Math.abs(a.wz - b.wz) < ENTITY_BOX
  for (const s of sprites) {
    const hits = clusters.filter(c => c.some(o => touches(o, s)))
    if (!hits.length) {
      clusters.push([s])
      continue
    }
    hits[0].push(s)
    for (const other of hits.slice(1)) {
      hits[0].push(...other)
      clusters.splice(clusters.indexOf(other), 1)
    }
  }
  for (const c of clusters) {
    for (const s of c) if (!texCache.has(s.name)) texCache.set(s.name, await entityMarkerTexture(lib, assets, s.name))
    const cx = c.reduce((a, s) => a + s.wx, 0) / c.length
    const cy = c.reduce((a, s) => a + s.wy, 0) / c.length
    const cz = c.reduce((a, s) => a + s.wz, 0) / c.length
    let tex = texCache.get(c[0].name)
    let px = 64
    if (c.length > 1) {
      const off = 4 // one icon pixel at the 64px render scale
      px = 64 + (c.length - 1) * off
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = px
      const ctx = canvas.getContext("2d")
      ctx.imageSmoothingEnabled = false
      for (let i = c.length - 1; i >= 0; i--) {
        const t = texCache.get(c[i].name)
        if (t) ctx.drawImage(t.image, (c.length - 1 - i) * off, (c.length - 1 - i) * off, 64, 64)
      }
      tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.magFilter = THREE.NearestFilter
      markerTextures.push(tex)
    }
    // alpha test, not blending: a blended sprite writes depth for empty pixels and
    // mis-sorts; SpriteMaterial defaults transparent to TRUE, so force it off
    const mat = tex
      ? new THREE.SpriteMaterial({ map: tex, alphaTest: 0.5, transparent: false })
      : new THREE.SpriteMaterial({ color: 0xffffff, opacity: 0.4 })
    const spr = new THREE.Sprite(mat)
    const scale = 10 * px / 64
    spr.scale.set(scale, scale, 1)
    spr.position.set(cx, cy - 8 + ENTITY_BOX / 2, cz)
    root.add(spr)
    draws++
    entityMarkers.push({ stack: c.map(s => s.e), x: cx, y: cy - 8, z: cz })
    for (const s of c) draws += await attachEntityTag(s.e.nbt, s.wx, s.wy - 8 + ENTITY_BOX, s.wz)
  }
  for (const tex of texCache.values()) if (tex) markerTextures.push(tex)
  relightFakeMaps()
  return draws
}

async function attachSpawnerEggs(structure, lib, assets) {
  let draws = 0
  const texCache = new Map()
  for (const b of structure.blocks) {
    if (!/(^|[:_])spawner$/.test(structure.palette[b.state]?.Name ?? "")) continue
    let id = b.nbt?.SpawnData?.entity?.id ?? b.nbt?.SpawnPotentials?.[0]?.data?.entity?.id
    if (!id) {
      const cfg = await readTrialSpawnerConfig(b.nbt?.normal_config)
      id = cfg?.spawn_potentials?.[0]?.data?.entity?.id
    }
    if (typeof id !== "string") continue
    const name = id.includes(":") ? id.split(":")[1] : id
    if (!texCache.has(name)) texCache.set(name, await entityMarkerTexture(lib, assets, name))
    const tex = texCache.get(name)
    if (!tex) continue
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, alphaTest: 0.5, transparent: false }))
    spr.scale.set(9, 9, 1)
    spr.position.set(b.pos[0] * 16, b.pos[1] * 16, b.pos[2] * 16)
    root.add(spr)
    draws++
  }
  for (const tex of texCache.values()) if (tex) markerTextures.push(tex)
  return draws
}

const SHELF_DISPLAY = { type: "fallback", display: "on_shelf" }
const SHELF_YAW = { south: 0, west: -Math.PI / 2, north: Math.PI, east: Math.PI / 2 }

async function attachShelves(structure, lib, assets) {
  let draws = 0
  const cache = new Map()
  for (const b of structure.blocks) {
    const entry = structure.palette[b.state]
    if (!/(^|_)shelf$/.test((entry?.Name ?? "").replace(/^minecraft:/, ""))) continue
    const items = b.nbt?.Items
    if (!Array.isArray(items) || !items.length) continue
    const alignBottom = Number(b.nbt.align_items_to_bottom ?? 0) === 1
    const facing = entry.Properties?.facing ?? "north"
    const g = new THREE.Group()
    for (const it of items) {
      if (typeof it?.id !== "string") continue
      const compass = /(^|:)compass$/.test(it.id)
      const clock = /(^|:)clock$/.test(it.id)
      const key = it.id + "|" + JSON.stringify(it.components ?? null) + (compass ? "|" + facing : "")
      let template = cache.get(key)
      if (template === undefined) {
        template = null
        try {
          const inner = new THREE.Group()
          inner.userData.daytime = daytimeUniform
          const itemData = { ...(it.components ?? {}) }
          if (compass) itemData["minecraft:compass"] = compassValue(facing, 0)
          if (clock) itemData["minecraft:time"] = clockValue(state.daytime)
          for (const m of await lib.parseItemDefinition(assets, it.id, { data: itemData, display: SHELF_DISPLAY, ignoreAtlases: true })) {
            const resolved = await lib.resolveModelData(assets, m)
            await lib.loadModel(inner, assets, resolved, { display: SHELF_DISPLAY, lighting: lightingOpt(sceneLight), animate: false })
          }
          if (inner.children.length) template = { inner, box: new THREE.Box3().setFromObject(inner) }
        } catch {}
        cache.set(key, template)
      }
      if (!template) continue
      const slot = Math.min(2, Math.max(0, Number(it.Slot ?? 0)))
      const inner = template.inner.clone()
      inner.position.y = -template.box.min.y - (alignBottom ? 0 : (template.box.max.y - template.box.min.y) / 2)
      const holder = new THREE.Group()
      holder.add(inner)
      holder.position.set((slot - 1) * 5, alignBottom ? -4 : 0, -4)
      holder.scale.setScalar(0.25)
      g.add(holder)
      if (clock) clockFrames.push({ holder: inner, item: it.id, components: it.components ?? {}, disp: SHELF_DISPLAY })
    }
    if (!g.children.length) continue
    g.userData.daytime = daytimeUniform
    g.rotation.y = SHELF_YAW[entry.Properties?.facing] ?? Math.PI
    g.position.set(b.pos[0] * 16, b.pos[1] * 16, b.pos[2] * 16)
    root.add(g)
    g.traverse(o => { if (o.isMesh) draws++ })
  }
  return draws
}

function boxForEntity(m) {
  if (m.box) return _aimBox.copy(m.box).translate(root.position)
  _aimBox.min.set(m.x - ENTITY_BOX / 2, m.y, m.z - ENTITY_BOX / 2)
  _aimBox.max.set(m.x + ENTITY_BOX / 2, m.y + (m.h ?? ENTITY_BOX), m.z + ENTITY_BOX / 2)
  _aimBox.translate(root.position)
  return _aimBox
}

const _markerV = new THREE.Vector3()
function markerUnderRay(ray, maxDist) {
  let best = null, bestD = maxDist
  for (const m of entityMarkers) {
    const p = ray.intersectBox(boxForEntity(m), _markerV)
    if (!p) continue
    const d = p.distanceTo(ray.origin)
    if (d < bestD) {
      bestD = d
      best = m
    }
  }
  return best
}

function toggleDoor(reg) {
  const structure = current.value
  const open = structure.palette[reg.b.state].Properties.open !== "true"
  const regs = reg.pair ? [reg, reg.pair] : [reg]
  for (const r of regs) {
    r.b.state = open ? r.openIdx : r.closedIdx
    setDoorInstance(r.openIdx, r.openSlot, r.b.pos, open)
    setDoorInstance(r.closedIdx, r.closedSlot, r.b.pos, !open)
  }
  return regs.map(r => r.b)
}

function rayBoxT(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
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

// block-centred local coords; merged meshes carry per-element boxes in
// userData.collision, so a stair keeps its stepped boxes
let collBoxCache = new Map()
let aimBoxCache = new Map()
const _cb = new THREE.Box3()
function templateBoxes(tmpl, arr) {
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
function templateFor(i, stateIdx) {
  if (sceneHandle && inputIdxOf) {
    const ii = i != null ? inputIdxOf[i] : -1
    if (ii >= 0) {
      const ti = sceneHandle.blockTemplate[ii]
      if (ti !== 0xFFFFFFFF) {
        const t = sceneHandle.templates[ti]
        return { key: "t" + ti, tmpl: t.group, soft: nonSolidPalette.has(t.palette) }
      }
    }
  }
  const tmpl = templates?.get(stateIdx)
  return tmpl ? { key: "s" + stateIdx, tmpl, soft: nonSolid.has(stateIdx) } : null
}

function collisionBoxesFor(i, stateIdx) {
  const t = templateFor(i, stateIdx)
  if (!t) return []
  let arr = collBoxCache.get(t.key)
  if (arr) return arr
  arr = []
  if (!t.soft) templateBoxes(t.tmpl, arr)
  collBoxCache.set(t.key, arr)
  return arr
}

function aimBoxesFor(i, stateIdx) {
  const t = templateFor(i, stateIdx)
  if (!t) return []
  const coll = collisionBoxesFor(i, stateIdx)
  if (coll.length || !t.soft) return coll
  let arr = aimBoxCache.get(t.key)
  if (arr) return arr
  arr = []
  templateBoxes(t.tmpl, arr)
  aimBoxCache.set(t.key, arr)
  return arr
}

// open fence gates have no collision in game: you walk through the cell
const GATE = /_fence_gate$/
const gateOpen = e => !!(e?.Name && GATE.test(e.Name) && e.Properties?.open === "true")


// returns { door }, { container }, { entity } or a plain { block }; blocked by
// real collision boxes, not whole cells, so it passes gaps like the game
const _aimBox = new THREE.Box3()
function rayHit(ox, oy, oz, dx, dy, dz, REACH = 80) {
  const structure = current.value
  if (!structure || !root) return null
  const idx = cellIndex()
  const rx = root.position.x, ry = root.position.y, rz = root.position.z
  function shapeT(bx, by, bz, e) {
    const s = shapeFor(e)
    const cx = bx * 16 + rx - 8, cy = by * 16 + ry - 8, cz = bz * 16 + rz - 8
    const t = rayBoxT(ox, oy, oz, dx, dy, dz, cx + s[0], cy + s[1], cz + s[2], cx + s[3], cy + s[4], cz + s[5])
    return t != null && t <= REACH
  }
  let entT = Infinity, entM = null
  for (const m of entityMarkers) {
    const b = boxForEntity(m)
    const t = rayBoxT(ox, oy, oz, dx, dy, dz, b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z)
    if (t != null && t <= REACH && t < entT) {
      entT = t
      entM = m
    }
  }
  let last = ""
  for (let t = 0; t <= REACH; t += 2) {
    const [bx, by, bz] = cellOf(ox + dx * t, oy + dy * t, oz + dz * t)
    const key = bx + "," + by + "," + bz
    if (key === last) continue
    last = key
    const reg = doorByCell.get(key)
    if (reg) {
      if (shapeT(bx, by, bz, structure.palette[reg.b.state])) return entT < t ? { entity: entM } : { door: reg }
      continue
    }
    const i = idx.get(key)
    if (i == null) continue
    const b = structure.blocks[i]
    const bName = structure.palette[b.state]?.Name ?? ""
    if ((isInspectable(bName) || b.nbt?.LootTable || /(^|[:_])spawner$/.test(bName)) && shapeT(bx, by, bz, structure.palette[b.state])) {
      return entT < t ? { entity: entM } : { container: b }
    }
    const cx = bx * 16 + rx, cy = by * 16 + ry, cz = bz * 16 + rz
    for (const s of aimBoxesFor(i, b.state)) {
      const th = rayBoxT(ox, oy, oz, dx, dy, dz, s[0] + cx, s[1] + cy, s[2] + cz, s[3] + cx, s[4] + cy, s[5] + cz)
      if (th != null && th <= REACH) return entT < th ? { entity: entM } : { block: b }
    }
  }
  return entM ? { entity: entM } : null
}

// { toggled: blocks }, { entity }, a container block, or false
function interact(ox, oy, oz, dx, dy, dz) {
  const h = rayHit(ox, oy, oz, dx, dy, dz)
  if (h?.door) return { toggled: toggleDoor(h.door) }
  if (h?.entity) return { entity: h.entity }
  return h?.container ?? false
}

// vanilla interaction shapes, fixed so pack remodels can't change them; the 3px
// panel sits on the face OPPOSITE the shape direction (DoorBlock boxZ(16,13,16))
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

function shapeFor(e) {
  const name = (e?.Name || "").replace(/^minecraft:/, "")
  const p = e?.Properties ?? {}
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
  if (/chest$/.test(name)) return [1, 0, 1, 15, 14, 15]
  if (/(^|_)shelf$/.test(name)) {
    const f = p.facing ?? "north"
    return f === "north" ? [0, 0, 11, 16, 16, 16]
      : f === "south" ? [0, 0, 0, 16, 16, 5]
      : f === "west" ? [11, 0, 0, 16, 16, 16]
      : [0, 0, 0, 5, 16, 16]
  }
  return [0, 0, 0, 16, 16, 16]
}

function boxForBlock(b) {
  if (!b || !root) return null
  const s = shapeFor(current.value?.palette[b.state])
  const ox = b.pos[0] * 16 + root.position.x - 8
  const oy = b.pos[1] * 16 + root.position.y - 8
  const oz = b.pos[2] * 16 + root.position.z - 8
  _aimBox.min.set(ox + s[0], oy + s[1], oz + s[2])
  _aimBox.max.set(ox + s[3], oy + s[4], oz + s[5])
  return _aimBox
}

function aimDoor(ox, oy, oz, dx, dy, dz) {
  const h = rayHit(ox, oy, oz, dx, dy, dz)
  if (!h) return null
  if (h.entity) return boxForEntity(h.entity)
  return boxForBlock(h.door ? h.door.b : h.container)
}

function blockEntryAt(wx, wy, wz) {
  const structure = current.value
  if (!structure || !root) return null
  const [bx, by, bz] = cellOf(wx, wy, wz)
  const i = cellIndex().get(bx + "," + by + "," + bz)
  return i == null ? null : structure.blocks[i]
}

function blockBoxes(b) {
  const structure = current.value
  const out = []
  if (!structure || !root) return out
  if (gateOpen(structure.palette[b.state])) return out
  const i = cellIndex().get(b.pos.join(","))
  const p = root.position
  const ox = p.x + b.pos[0] * 16, oy = p.y + b.pos[1] * 16, oz = p.z + b.pos[2] * 16
  for (const l of collisionBoxesFor(i, b.state)) out.push({ nx: l[0] + ox, ny: l[1] + oy, nz: l[2] + oz, px: l[3] + ox, py: l[4] + oy, pz: l[5] + oz })
  return out
}


function disposeGroup(g) {
  if (!g) return
  g.traverse(o => {
    if (!o.isMesh || o.userData.shared) return
    if (o.isInstancedMesh) o.dispose()
    o.geometry?.dispose()
    // ownsMap: sign canvases only; atlas and library textures are managed elsewhere
    if (o.userData.ownsMap) o.material?.map?.dispose?.()
    for (const m of [].concat(o.material)) m?.dispose?.()
  })
  g.removeFromParent()
}

function disposeBundle(b) {
  sceneApi.animators.delete(b.animator)
  disposeGroup(b.group)
  b.handle?.dispose()
  for (const t of b.markerTextures) t.dispose()
  b.sceneLight?.dispose()
}

function discardFull() {
  if (!fullBundle) return
  disposeBundle(fullBundle)
  fullBundle = null
}

function showFull(on) {
  if (!fullBundle || !root) return false
  fullBundle.group.visible = !!on
  root.visible = !on
  if (on) sceneApi.animators.add(fullBundle.animator)
  else sceneApi.animators.delete(fullBundle.animator)
  return true
}

function restoreFull() {
  if (!fullBundle || state.building) return false
  const old = root, oldHandle = sceneHandle, oldMarkerTex = markerTextures, oldAnimator = animator, oldLight = sceneLight
  ;({ group: root, handle: sceneHandle, inputIdxOf, nonSolidPalette, markerTextures, animator, entityMarkers, doorByCell, sceneLight, fakeMaps, mapLightEnv } = fullBundle)
  current.value = fullBundle.structure
  state.info = fullBundle.info
  relightFakeMaps()
  root.visible = true
  sceneApi.contentRoots.add(root)
  sceneApi.syncAspect()
  sceneApi.animators.add(animator)
  fullBundle = null
  rootSliced = false
  collBoxCache = new Map()
  aimBoxCache = new Map()
  if (old) {
    sceneApi.contentRoots.delete(old)
    sceneApi.animators.delete(oldAnimator)
    disposeGroup(old)
    oldHandle?.dispose()
    for (const t of oldMarkerTex) t.dispose()
    oldLight?.dispose()
  }
  return true
}

let cancelBuild = false
function cancel() {
  if (!state.building) return
  cancelBuild = true
  state.status = "cancelling…"
}

// true when a build landed, false when cancelled
async function build(structure = source, refit = true, slice = false) {
  const assets = packs.assets.value
  if (!assets || !structure || state.building) return
  state.building = true
  cancelBuild = false
  lock(true)
  const prevCurrent = current.value, prevSource = source, prevHasSB = state.hasStructureBlocks, prevInfo = state.info,
    prevInputIdx = inputIdxOf, prevNonSolidPalette = nonSolidPalette
  let newLight = null
  function abort() {
    newLight?.dispose()
    current.value = prevCurrent
    source = prevSource
    state.hasStructureBlocks = prevHasSB
    state.status = ""
    return false
  }
  try {
    source = structure
    const techStates = new Set()
    structure.palette.forEach((e, i) => {
      if (e?.Name && (JIGSAW.test(e.Name) || SB.test(e.Name))) techStates.add(i)
    })
    state.hasStructureBlocks = techStates.size > 0 && structure.blocks.some(b => techStates.has(b.state))
    if (state.hideStructureBlocks) structure = stripStructureBlocks(structure)
    // sliced blocks are dropped for real (solid cut faces); size and position stay the full structure's
    const unsliced = structure
    if (slice) structure = useSlicers().sliceStructure(structure)
    const slicedApplied = structure !== unsliced
    current.value = structure
    const lib = await loadLibrary()
    const [sx, sy, sz] = structure.size
    state.status = "building…"
    buildDim = !state.fullbright && /^(the_nether|the_end)$/.test(unsliced.dimension) ? unsliced.dimension : "overworld"

    // flood filled over what actually builds, so a slice relights; oversized scenes skip it
    if (state.lighting === "world" && !state.fullbright && lib.computeSceneLight && (sx + 2) * (sy + 2) * (sz + 2) <= 48000000) {
      const lightBlocks = []
      for (const b of structure.blocks) {
        const e = structure.palette[b.state]
        if (!e?.Name || AIR.test(e.Name)) continue
        const name = LEGACY_RENAMES[e.Name.replace("minecraft:", "")] ?? e.Name
        lightBlocks.push({ id: name, properties: fixLegacyProps(name.replace("minecraft:", ""), e.Properties) ?? {}, pos: b.pos })
      }
      if (lightBlocks.length) {
        state.status = "lighting…"
        newLight = await lib.computeSceneLight(lightBlocks, {
          assets,
          dimension: buildDim,
          onProgress: (done, total) => { state.progress = { phase: "light", done, total } }
        })
        if (cancelBuild) return abort()
        state.status = "building…"
      }
    }

    templates = new Map()
    nonSolid = new Set()
    nonSolidPalette = new Set()
    collBoxCache = new Map()
    aimBoxCache = new Map()
    const isPlane = el => el.from[0] === el.to[0] || el.from[1] === el.to[1] || el.from[2] === el.to[2]

    // doors and loader-variant states keep their own templates outside createScene
    async function buildStateTemplate(stateIdx) {
      if (templates.has(stateIdx)) return templates.get(stateIdx)
      const entry = structure.palette[stateIdx]
      const g = new THREE.Group()
      g.userData.daytime = daytimeUniform
      let tmpl = null
      try {
        const name = LEGACY_RENAMES[entry.Name.replace("minecraft:", "")] ?? entry.Name
        const props = fixLegacyProps(name.replace("minecraft:", ""), entry.Properties)
        const block = entry.__block ?? { id: name, properties: props ?? {} }
        const biome = entry.__biome ? { biome: entry.__biome } : null
        let any = false, allPlanes = true
        for (const model of await lib.parseBlockstate(assets, name, { data: props ?? {}, ignoreAtlases: true, ...biome })) {
          const data = await lib.resolveModelData(assets, model)
          await lib.loadModel(g, assets, data, { display: {}, lighting: lightingOpt(newLight), animate: false, block, neighbors: block.neighbors })
          for (const el of data?.elements ?? []) { any = true; if (!isPlane(el)) allPlanes = false }
        }
        if (any && allPlanes) nonSolid.add(stateIdx)
        if (g.children.length) tmpl = g
      } catch {}
      templates.set(stateIdx, tmpl)
      return tmpl
    }
    if (lib.ModelLoader) await remapLoaderStates(structure, lib, assets)
    if (cancelBuild) return abort()

    const inputBlocks = []
    const inputIdx = new Int32Array(structure.blocks.length).fill(-1)
    for (let i = 0; i < structure.blocks.length; i++) {
      const b = structure.blocks[i]
      const e = structure.palette[b.state]
      if (!e?.Name || AIR.test(e.Name) || isOpenable(e) || e.__loaderKey) continue
      const name = LEGACY_RENAMES[e.Name.replace("minecraft:", "")] ?? e.Name
      const props = fixLegacyProps(name.replace("minecraft:", ""), e.Properties)
      const entry = { id: name, pos: b.pos }
      if (props) entry.properties = props
      if (e.__biome) entry.biome = e.__biome
      inputIdx[i] = inputBlocks.length
      inputBlocks.push(entry)
    }
    const total = inputBlocks.length

    const perfCal = loadPerf()
    let warnedOnce = false
    if (!await restoreGateCheck(total)) return abort()
    if (perfCal) {
      const estMs = total * (perfCal.b + perfCal.o)
      if (estMs > WARN_MS) {
        warnedOnce = true
        if (!await askWarn(estMs)) return abort()
      }
    }
    const tBuild = performance.now()
    let tOpt = null

    const handle = await lib.createScene(assets, inputBlocks, {
      lighting: state.lighting === "world" ? { dimension: buildDim, light: newLight ?? false, daytime: state.daytime } : state.lighting,
      keepTemplates: true,
      ignoreAtlases: true,
      animate: false,
      onProgress: (stage, done, tot) => {
        if (stage.name === "optimize") {
          tOpt ??= performance.now()
          state.status = `optimising… ${Math.round(done / tot * 100)}%`
          state.progress = { phase: "optimise", done, total: tot }
        } else if (stage.name === "light") {
          state.status = "lighting…"
          state.progress = { phase: "light", done, total: tot }
        } else {
          const f = stage.name === "parse" ? done / tot * 0.15 : 0.15 + done / tot * 0.85
          state.status = `building… ${Math.round(f * 100)}%`
          state.progress = { phase: "build", done: Math.round(f * 10000), total: 10000 }
        }
        // uncalibrated runs project from live progress; declining the dialog cancels the build
        if (!warnedOnce && !perfCal && stage.name !== "optimize") {
          const elapsed = performance.now() - tBuild
          const overall = (stage.index + done / tot) / stage.count
          if (elapsed > 1500 && overall > 0.02) {
            warnedOnce = true
            const projected = elapsed / overall
            if (projected > WARN_MS) askWarn(projected).then(ok => { if (!ok) cancelBuild = true })
          }
        }
      },
      shouldCancel: () => cancelBuild
    })
    if (!handle || cancelBuild) {
      handle?.dispose()
      return abort()
    }

    for (let pi = 0; pi < handle.palette.length; pi++) {
      try {
        let any = false, allPlanes = true
        for (const model of handle.palette[pi].models) {
          const data = await lib.resolveModelData(assets, model)
          for (const el of data?.elements ?? []) { any = true; if (!isPlane(el)) allPlanes = false }
        }
        if (any && allPlanes) nonSolidPalette.add(pi)
      } catch {}
    }
    if (cancelBuild) {
      handle.dispose()
      return abort()
    }

    // a centre ≡ 8 (mod 16) keeps block-centred templates on the grid lattice
    const gridCentre = v => Math.round((v - 8) / 16) * 16 + 8
    const position = new THREE.Vector3(gridCentre(-(sx - 1) * 8), gridCentre(-(sy - 1) * 8), gridCentre(-(sz - 1) * 8))
    newLight?.setOffset(position)

    const doorEntries = []
    for (const b of structure.blocks) {
      if (!isOpenable(structure.palette[b.state])) continue
      const openIdx = stateWithOpen(structure, b.state, "true")
      const closedIdx = stateWithOpen(structure, b.state, "false")
      await buildStateTemplate(openIdx)
      await buildStateTemplate(closedIdx)
      doorEntries.push({ b, openIdx, closedIdx })
      if (cancelBuild) {
        handle.dispose()
        return abort()
      }
    }

    // multi-part states and uvlock rotations (baked UVs) can't share: per-state fallback
    stateRender = new Map()
    canonDoorTmpl = new Map()
    for (const e of doorEntries) {
      for (const stateIdx of [e.openIdx, e.closedIdx]) {
        if (stateRender.has(stateIdx)) continue
        const entry = structure.palette[stateIdx]
        let key = null
        const rot = new THREE.Matrix4()
        try {
          const name = LEGACY_RENAMES[entry.Name.replace("minecraft:", "")] ?? entry.Name
          const props = fixLegacyProps(name.replace("minecraft:", ""), entry.Properties)
          const models = await lib.parseBlockstate(assets, name, { data: props ?? {}, ignoreAtlases: true })
          const m = models.length === 1 ? models[0] : null
          if (m && !(m.uvlock && (m.x || m.y || m.z))) {
            key = JSON.stringify({ ...m, x: 0, y: 0, z: 0 })
            // same convention loadModel bakes: rotation.set(-x, -y, z, "ZYX")
            rot.makeRotationFromEuler(new THREE.Euler(
              THREE.MathUtils.degToRad(-(m.x ?? 0)),
              THREE.MathUtils.degToRad(-(m.y ?? 0)),
              THREE.MathUtils.degToRad(m.z ?? 0), "ZYX"))
            if (!canonDoorTmpl.has(key)) {
              const g = new THREE.Group()
              g.userData.daytime = daytimeUniform
              const data = await lib.resolveModelData(assets, { ...m, x: 0, y: 0, z: 0 })
              await lib.loadModel(g, assets, data, { display: {}, lighting: lightingOpt(newLight), animate: false })
              canonDoorTmpl.set(key, g.children.length ? g : null)
            }
            if (!canonDoorTmpl.get(key)) key = null
          }
        } catch {}
        if (!key) {
          key = "state:" + stateIdx
          rot.identity()
          canonDoorTmpl.set(key, templates.get(stateIdx))
        }
        stateRender.set(stateIdx, { key, rot })
      }
    }

    let loaderDraws = 0, loaderTris = 0, loaderCount = 0
    for (const b of structure.blocks) {
      if (!structure.palette[b.state]?.__loaderKey) continue
      const tmpl = await buildStateTemplate(b.state)
      if (cancelBuild) {
        handle.dispose()
        return abort()
      }
      if (!tmpl) continue
      const inst = tmpl.clone()
      inst.position.set(b.pos[0] * 16, b.pos[1] * 16, b.pos[2] * 16)
      handle.group.add(inst)
      loaderCount++
      inst.traverse(o => {
        if (!o.isMesh) return
        loaderDraws++
        loaderTris += (o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0) / 3
      })
    }

    // tiny builds are all fixed cost and would poison the per-block rates
    if (total >= 2000 && tOpt) savePerf((tOpt - tBuild) / total, (performance.now() - tOpt) / total)
    handle.group.position.copy(position)
    const next = handle.group
    const drawCalls = handle.drawCalls + loaderDraws
    const tris = handle.tris + loaderTris
    const placedCount = total + doorEntries.length + loaderCount

    const old = root, oldHandle = sceneHandle, oldMarkerTex = markerTextures,
      oldAnimator = animator, oldMarkers = entityMarkers, oldDoors = doorByCell, oldLight = sceneLight, oldFakeMaps = fakeMaps, oldMapEnv = mapLightEnv
    root = next
    sceneHandle = handle
    inputIdxOf = inputIdx
    sceneLight = newLight
    markerTextures = []
    sceneApi.scene.add(root)
    sceneApi.contentRoots.add(root)
    sceneApi.syncAspect()
    if (old) sceneApi.contentRoots.delete(old)
    if (animator) sceneApi.animators.delete(animator)
    const doorDraws = attachDoors(doorEntries)
    const entityDraws = await attachEntities(structure, lib, assets) + await attachSpawnerEggs(structure, lib, assets) + await attachShelves(structure, lib, assets)
    try {
      const signs = await makeSignTexts(structure)
      if (signs) root.add(signs)
    } catch {}
    animator = lib.createAnimator(root)
    sceneApi.animators.add(animator)
    useSlicers().onBuild(root, position, [sx, sy, sz], slicedApplied)
    const parts = structure.__parts ?? [{ off: [0, 0, 0], size: structure.size }]
    // cave cells are clipped to the grid footprint so the outline closes along the grid edge
    let caveWire = null
    if (structure.cave) {
      const c = structure.cave
      const p0 = parts[0]
      const gw = p0.size[0] + 6, gd = p0.size[2] + 6
      const xMin = p0.off[0] - 3, zMin = p0.off[2] - 3
      const cells = new Set()
      for (const [x, z] of c.cells) {
        if (x >= xMin && x < xMin + gw && z >= zMin && z < zMin + gd) cells.add(x + "," + z)
      }
      const segs = []
      for (const k of cells) {
        const [x, z] = k.split(",").map(Number)
        if (!cells.has((x - 1) + "," + z)) segs.push([x, z, x, z + 1])
        if (!cells.has((x + 1) + "," + z)) segs.push([x + 1, z, x + 1, z + 1])
        if (!cells.has(x + "," + (z - 1))) segs.push([x, z, x + 1, z])
        if (!cells.has(x + "," + (z + 1))) segs.push([x, z + 1, x + 1, z + 1])
      }
      const tx = v => position.x + v * 16 - 8, tz = v => position.z + v * 16 - 8
      caveWire = {
        segments: segs.map(([x0, z0, x1, z1]) => [tx(x0), tz(z0), tx(x1), tz(z1)]),
        y0: position.y + c.y0 * 16 - 8.01,
        y1: position.y + c.y1 * 16 - 8,
        has: (wx, wz) => cells.has(Math.floor((wx - position.x + 8) / 16) + "," + Math.floor((wz - position.z + 8) / 16))
      }
    }
    sceneApi.setGrids(parts.map(p => {
      const gw = p.size[0] + 6, gd = p.size[2] + 6
      return {
        x: position.x + (p.off[0] - 3) * 16 - 8,
        z: position.z + (p.off[2] - 3) * 16 - 8,
        y: position.y + p.off[1] * 16 - 8.01,
        w: gw,
        d: gd,
        label: p.name
      }
    }), caveWire)
    if (refit) sceneApi.fit()
    state.info = {
      size: `${sx}×${sy}×${sz}`,
      blocks: placedCount,
      palette: handle.palette.length,
      draws: drawCalls + doorDraws + entityDraws,
      tris
    }
    state.status = ""
    // a new source (or a full build of the same one) invalidates the kept full build
    if (prevSource !== source || !slicedApplied) discardFull()
    if (slicedApplied && old && prevSource === source && !rootSliced && !fullBundle) {
      old.visible = false
      fullBundle = {
        group: old, handle: oldHandle, inputIdxOf: prevInputIdx, nonSolidPalette: prevNonSolidPalette,
        markerTextures: oldMarkerTex, animator: oldAnimator,
        structure: prevCurrent, info: prevInfo, entityMarkers: oldMarkers, doorByCell: oldDoors, sceneLight: oldLight, fakeMaps: oldFakeMaps, mapLightEnv: oldMapEnv
      }
    } else if (old) {
      disposeGroup(old)
      oldHandle?.dispose()
      for (const t of oldMarkerTex) t.dispose()
      oldLight?.dispose()
    }
    if (fullBundle) {
      fullBundle.group.visible = false
      sceneApi.animators.delete(fullBundle.animator)
    }
    rootSliced = slicedApplied
    return true
  } finally {
    state.building = false
    state.progress = null
    lock(false)
  }
}

watch(() => [state.lighting, state.fullbright], () => build(undefined, false))
watch(() => state.hideStructureBlocks, v => {
  localStorage.setItem("hideStructureBlocks", String(v))
  build(undefined, false)
})

async function exportCurrent(format, name) {
  if (!root || state.building) return
  lock(true)
  state.status = "exporting…"
  try {
    await exportScene({ format, name, root })
    state.status = ""
  } catch (err) {
    state.status = `export failed: ${err}`
  } finally {
    lock(false)
  }
}

const getRoot = () => root
const getTemplates = () => templates
const getNonSolid = () => nonSolid

export function useBuild() {
  return {
    state, current, build, cancel, answerWarn, setRestoreGate, restoreGateCheck, getRoot, getTemplates, getNonSolid, showFull, restoreFull,
    blockAt, blockEntryAt, boxForBlock, boxForEntity, markerUnderRay, rayHit, interact, aimDoor, blockBoxes, exportCurrent
  }
}
