import { reactive, readonly, shallowRef, watch } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useScene } from "./useScene.js"
import { useSlicers } from "./useSlicers.js"
import { useLock } from "./useLock.js"
import { optimise } from "../optimise.js"
import { yieldTask } from "../yield.js"
import { exportScene } from "../export.js"
import { makeSignTexts, plainText } from "../signs.js"
import { JIGSAW, parseState } from "../transforms.js"
import { isInspectable, readTrialSpawnerConfig } from "../loot.js"
import { getFont, measure, drawText } from "../mcfont.js"

const packs = usePacks()
const sceneApi = useScene()
const { lock } = useLock()

const AIR = /(^|:)(air|cave_air|void_air|structure_void)$/

// structures saved in older versions use block names that were later renamed;
// the pack only has the current names. exact-id lookups, common cases only
const LEGACY_RENAMES = {
  grass: "short_grass",
  grass_path: "dirt_path",
  chain: "iron_chain",
  sign: "oak_sign",
  wall_sign: "oak_wall_sign"
}

// display option: technical blocks resolved away, like the game after
// generation: jigsaws become their final_state, structure blocks disappear
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

// fluid cells: corner heights depend on the neighbourhood, so each distinct
// surface shape gets a synthetic palette entry carrying its heights; identical
// cells (open water, full columns) still share one template. the library
// decides what counts as a fluid cell (fluids, waterlogged states, and
// inherently water-filled blocks like kelp or bubble columns)
async function remapFluidStates(structure, lib, assets) {
  const byPos = new Map()
  for (const b of structure.blocks) byPos.set(b.pos.join(","), b)
  const byKey = new Map()
  structure.palette.forEach((e, i) => { if (e?.__fluidKey) byKey.set(e.__fluidKey, i) })
  // hot caches resolve every await as a microtask, which never yields the
  // event loop: force real yields so water-heavy loads don't freeze the page
  let seen = 0
  for (const b of structure.blocks) {
    if (++seen % 2000 === 0) {
      state.status = `water surfaces… ${seen}/${structure.blocks.length}`
      // the water pass is the front of the build bar's unified 0..10000 sweep
      state.progress = { phase: "build", done: Math.round(seen / structure.blocks.length * 1500), total: 10000 }
      await yieldTask()
      if (cancelBuild) return
    }
    const e = structure.palette[b.state]
    if (!e?.Name) continue
    const type = lib.fluidTypeOf?.(e.Name, e.Properties) ?? null
    if (!type) continue
    const [bx, by, bz] = b.pos
    const neighbors = {}
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nb = byPos.get((bx + dx) + "," + (by + dy) + "," + (bz + dz))
      const ne = nb && structure.palette[nb.state]
      if (!ne?.Name) continue
      let k = !dx && !dy && !dz ? "self" : dy === 1 ? "up" : dy === -1 ? "down" : ""
      if (dx || dy || dz) {
        if (dz === -1) k += (k ? "_" : "") + "north"
        else if (dz === 1) k += (k ? "_" : "") + "south"
        if (dx === -1) k += (k ? "_" : "") + "west"
        else if (dx === 1) k += (k ? "_" : "") + "east"
      }
      neighbors[k] = { id: ne.Name, ...(ne.Properties ?? {}) }
    }
    const h = await lib.fluidHeights(assets, type, neighbors)
    const ov = h.overlay ? (h.overlay.north ? "n" : "") + (h.overlay.south ? "s" : "") + (h.overlay.east ? "e" : "") + (h.overlay.west ? "w" : "") : ""
    const sm = h.same ? (h.same.north ? "n" : "") + (h.same.south ? "s" : "") + (h.same.east ? "e" : "") + (h.same.west ? "w" : "") + (h.same.up ? "u" : "") + (h.same.down ? "d" : "") : ""
    const key = `${e.Name}|${JSON.stringify(e.Properties ?? null)}|${h.nw.toFixed(3)},${h.ne.toFixed(3)},${h.sw.toFixed(3)},${h.se.toFixed(3)}|${h.full ? 1 : 0}|${h.angle == null ? "" : h.angle.toFixed(2)}|${ov}|${sm}`
    let idx = byKey.get(key)
    if (idx === undefined) {
      idx = structure.palette.length
      const entry = { Name: e.Name }
      if (e.Properties) entry.Properties = e.Properties
      entry.__fluidHeights = h
      entry.__fluidKey = key
      structure.palette.push(entry)
      byKey.set(key, idx)
    }
    b.state = idx
  }
}

// DEV: blocks whose models match a registered custom loader build per
// placement (connected variants from neighbours, block entity content from
// nbt); same synthetic-palette trick as fluids. no-op with no loaders
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
  daytime: NOON,
  hideStructureBlocks: localStorage.getItem("hideStructureBlocks") !== "false",
  hasStructureBlocks: false,
  building: false,
  status: "",
  progress: null, // { phase: "build" | "optimise", done, total } while working
  info: null,
  warn: null // { seconds } while a slow-build confirmation is showing
})

// slow-build warning: estimates come from this machine's measured rates
// (ms per block for the template pass and the optimise pass, EMA over
// completed builds); with no history yet, the build phase self-samples
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

function answerWarn(ok) {
  state.warn = null
  warnResolve?.(ok)
  warnResolve = null
}

// One live uniform shared by every world-lighting material: seeding it into a
// template group's userData before loadModel makes the library reuse it (and
// optimizeScene re-shares it onto atlas materials), so changing state.daytime
// re-lights the whole scene with no rebuild.
const daytimeUniform = { value: NOON }
watch(() => state.daytime, v => { daytimeUniform.value = v })

// ---- openable blocks (doors/trapdoors/gates): never baked into the merged
// mesh. both open + closed models are pre-built and a toggle just flips which
// clone is visible, so no rebuild is needed.
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
if (typeof window !== "undefined") window.__vroot = () => root
let animator = null
let templates = null
let nonSolid = new Set()
let atlasTextures = [] // the displayed atlases; swapped + disposed on rebuild
let sceneLight = null // the displayed build's light volume; swapped + disposed like the atlases
let entityMarkers = [] // billboarded entities: { e, x, y, z } in root-local coords
let markerTextures = []
let doorByCell = new Map()
let blockMap = null, blockMapFor = null

// slice builds keep the full build hidden instead of disposing it, so a
// slicer drag can reveal blocks instantly (clipped live) and slicers
// turning off swap it straight back without a rebuild
let fullBundle = null
let rootSliced = false

// palette index for the same block with a different `open` value (added if new)
function stateWithOpen(structure, stateIdx, open) {
  const e = structure.palette[stateIdx], props = { ...e.Properties, open }
  let idx = structure.palette.findIndex(pe => pe.Name === e.Name && sameProps(pe.Properties, props))
  if (idx < 0) {
    idx = structure.palette.length
    structure.palette.push({ Name: e.Name, Properties: props })
  }
  return idx
}

// cell -> block index, lazily rebuilt per structure (walk mode asks what
// block is at a world point: ladders, and which door is being looked at)
function cellIndex() {
  const structure = current.value
  if (blockMapFor !== structure) {
    blockMap = new Map()
    structure.blocks.forEach((b, i) => blockMap.set(b.pos[0] + "," + b.pos[1] + "," + b.pos[2], i))
    blockMapFor = structure
  }
  return blockMap
}

// block geometry is centred on i*16, so the cell is the NEAREST multiple of
// 16: round, not floor, else every block straddles two cells
const cellOf = (wx, wy, wz) => [Math.round((wx - root.position.x) / 16), Math.round((wy - root.position.y) / 16), Math.round((wz - root.position.z) / 16)]

function blockAt(wx, wy, wz) {
  const structure = current.value
  if (!structure || !root) return null
  const [bx, by, bz] = cellOf(wx, wy, wz)
  const i = cellIndex().get(bx + "," + by + "," + bz)
  return i == null ? null : structure.palette[structure.blocks[i].state]
}

// openable blocks render as ONE InstancedMesh per unique MODEL per template
// mesh, not per-block clone groups: a build with hundreds of trapdoors was
// thousands of draw calls. states that differ only by blockstate rotation
// (facing etc.) share one canonical unrotated template, with the rotation
// folded into each instance matrix (the shader lights from instance-space
// normals, so shading stays correct). a hidden instance is collapsed to zero
// scale, so toggling stays a matrix write with no rebuild
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
  // an instance slot per placement of each open/closed state, in the state's
  // canonical group
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
      // instances spread across the structure; the geometry's own bounds
      // would frustum-cull them all wrongly
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

// structure entities whose id also resolves as a block (the cushion
// overrides, straw-bed-style blocks) render as live models at the entity's
// exact position: no cull faces, never a neighbour to anything, no collision.
// yaw snaps to the nearest cardinal like the game's Direction.fromYRot.
// everything else gets a billboarded spawn-egg marker inside a fixed
// 14x14x14 hitbox so its existence and nbt are visible/clickable
const ENTITY_BOX = 14

async function entityMarkerTexture(lib, assets, name) {
  const c = document.createElement("canvas")
  c.width = 64
  c.height = 64
  let drawn = false
  for (const item of [name + "_spawn_egg", name]) {
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

// the in-game nametag: white minecraft-font text on a translucent plate,
// floating above the entity
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

async function attachEntities(structure, lib, assets) {
  let draws = 0
  const groupCache = new Map()
  const texCache = new Map()
  const sprites = [] // marker entities, deferred so overlapping ones merge
  entityMarkers = []
  for (const e of structure.entities ?? []) {
    const id = e.nbt?.id
    if (typeof id !== "string") continue
    const [ns, name] = id.includes(":") ? id.split(":") : ["minecraft", id]
    const yaw = Number(e.nbt.Rotation?.[0] ?? 0)
    const facing = ["south", "west", "north", "east"][((Math.floor(yaw / 90 + 0.5) % 4) + 4) % 4]
    const data = { facing }
    for (const [k, v] of Object.entries(e.nbt)) if (typeof v === "string" && k !== "id") data[k] = v
    const key = id + "|" + JSON.stringify(data)
    let template = groupCache.get(key)
    if (template === undefined) {
      template = null
      try {
        // coloured entity forms (cushions) have no blockstate of their own:
        // the entity's colour picks the per-colour block, white when unset
        let blockId = null
        if (await lib.readFile(`assets/${ns}/blockstates/${name}.json`, assets)) blockId = id
        else {
          const coloured = `${typeof data.color === "string" ? data.color : "white"}_${name}`
          if (await lib.readFile(`assets/${ns}/blockstates/${coloured}.json`, assets)) blockId = `${ns}:${coloured}`
        }
        if (blockId) {
          const g = new THREE.Group()
          g.userData.daytime = daytimeUniform
          for (const model of await lib.parseBlockstate(assets, blockId, { data, ignoreAtlases: true })) {
            const data = await lib.resolveModelData(assets, model)
            await lib.loadModel(g, assets, data, { display: {}, lighting: state.lighting, light: sceneLight, animate: false })
          }
          if (g.children.length) template = g
        }
      } catch {}
      groupCache.set(key, template)
    }
    // block units -> world: cell centres sit at pos*16, cells span +-8, so a
    // point maps to pos*16 - 8; the template's bottom is -8, hence y stays
    const wx = e.pos[0] * 16 - 8, wy = e.pos[1] * 16, wz = e.pos[2] * 16 - 8
    if (template) {
      const g = groupCache.get(key).clone()
      g.position.set(wx, wy, wz)
      root.add(g)
      g.traverse(o => { if (o.isMesh) draws++ })
      draws += await attachEntityTag(e.nbt, wx, new THREE.Box3().setFromObject(g).max.y, wz)
      continue
    }
    sprites.push({ e, name, wx, wy, wz })
  }

  // markers whose click hitboxes overlap merge: one marker at the centre of
  // the group, every icon composited into the same billboard (first in the
  // middle, each next one a pixel up, left and behind)
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
    // opaque pass + alpha test, not transparent: a blended sprite writes
    // depth for its empty pixels (holes in water) and sorts against other
    // transparents by centre distance (pops in front from behind). unlike
    // every other material, SpriteMaterial defaults transparent to TRUE, so
    // it must be forced off explicitly
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
  return draws
}

// mob spawners show their entity's spawn egg floating inside the cage
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

// the fixed hitbox anchored at the entity's feet, taller for a stack
function boxForEntity(m) {
  _aimBox.min.set(m.x - ENTITY_BOX / 2, m.y, m.z - ENTITY_BOX / 2)
  _aimBox.max.set(m.x + ENTITY_BOX / 2, m.y + (m.h ?? ENTITY_BOX), m.z + ENTITY_BOX / 2)
  _aimBox.translate(root.position)
  return _aimBox
}

// nearest entity hitbox along a picking ray, ignoring anything past maxDist
// (a mesh hit in front). the sprite quad itself never decides the hit
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

// flip an openable block (and the other door half): swap the instance
// matrices and repoint its state so collision boxes follow
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

// ray vs axis-aligned box: entry t, or null when it misses
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

// per-state collision AABBs (template mesh boxes, block-centred local
// coords), the same shapes the walker collides with. flat-plane models
// (plants, rails...) have none, so they never block the ray. the library
// merges multi-element models into one mesh per material, so merged groups
// carry the per-element boxes in userData.collision (a stair keeps its
// stepped boxes instead of collapsing into a full cube)
let collBoxCache = new Map()
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
function collisionBoxes(stateIdx) {
  let arr = collBoxCache.get(stateIdx)
  if (arr) return arr
  arr = []
  const tmpl = templates.get(stateIdx)
  if (tmpl && !nonSolid.has(stateIdx)) templateBoxes(tmpl, arr)
  collBoxCache.set(stateIdx, arr)
  return arr
}

// open fence gates have no collision in game: you walk through the cell
const GATE = /_fence_gate$/
const gateOpen = e => !!(e?.Name && GATE.test(e.Name) && e.Properties?.open === "true")


// march the look ray; return the first interactable whose vanilla shape the
// ray actually crosses: an openable ({ door }) or a loot container
// ({ container }). the ray is blocked by real collision boxes, not whole
// cells, so it passes over slabs and through gaps like the game; a plain
// blocker comes back as { block } for the aim readout
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
    for (const s of collisionBoxes(b.state)) {
      const th = rayBoxT(ox, oy, oz, dx, dy, dz, s[0] + cx, s[1] + cy, s[2] + cz, s[3] + cx, s[4] + cy, s[5] + cz)
      if (th != null && th <= REACH) return entT < th ? { entity: entM } : { block: b }
    }
  }
  return entM ? { entity: entM } : null
}

// act on the thing being looked at: toggles a door ({ toggled: blocks }),
// hands back a loot container block or { entity }, or false when nothing
// is in reach
function interact(ox, oy, oz, dx, dy, dz) {
  const h = rayHit(ox, oy, oz, dx, dy, dz)
  if (h?.door) return { toggled: toggleDoor(h.door) }
  if (h?.entity) return { entity: h.entity }
  return h?.container ?? false
}

// vanilla interaction shapes for every clickable block, fixed so resource
// pack remodels can't change them. doors/trapdoors are a 3px panel on the
// face OPPOSITE the shape direction (DoorBlock/TrapDoorBlock boxZ(16,13,16)):
// door closed -> facing, open -> hinge-rotated; trapdoor closed -> half,
// open -> facing. gates are a full-width 4px band (13 tall in a wall),
// chests the 14-wide body without the knob, the rest a full cube
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

// box of the interactable being looked at (in-reach outline)
function aimDoor(ox, oy, oz, dx, dy, dz) {
  const h = rayHit(ox, oy, oz, dx, dy, dz)
  if (!h) return null
  if (h.entity) return boxForEntity(h.entity)
  return boxForBlock(h.door ? h.door.b : h.container)
}

// the raw structure block at a world position (orbit-mode picking)
function blockEntryAt(wx, wy, wz) {
  const structure = current.value
  if (!structure || !root) return null
  const [bx, by, bz] = cellOf(wx, wy, wz)
  const i = cellIndex().get(bx + "," + by + "," + bz)
  return i == null ? null : structure.blocks[i]
}

// real world-space collision AABBs of the current structure: one per model
// element (a stair yields its stepped boxes, a slab a half box), per block.
// each box carries its block's cell key so a door toggle can swap just that
// cell's boxes in the walker's spatial hash
function blockBoxes(b) {
  const structure = current.value
  const out = []
  if (!structure || !root) return out
  if (nonSolid.has(b.state) || gateOpen(structure.palette[b.state])) return out
  const p = root.position
  const ox = p.x + b.pos[0] * 16, oy = p.y + b.pos[1] * 16, oz = p.z + b.pos[2] * 16
  const key = b.pos.join(",")
  for (const l of collisionBoxes(b.state)) out.push({ nx: l[0] + ox, ny: l[1] + oy, nz: l[2] + oz, px: l[3] + ox, py: l[4] + oy, pz: l[5] + oz, key })
  return out
}

function currentBoxes() {
  const structure = current.value
  const out = []
  if (!structure || !root || !templates) return out
  for (const b of structure.blocks) out.push(...blockBoxes(b))
  return out
}


function disposeGroup(g) {
  if (!g) return
  g.traverse(o => {
    if (!o.isMesh || o.userData.shared) return
    if (o.isInstancedMesh) o.dispose()
    o.geometry?.dispose()
    // only textures created for this mesh (sign text canvases): atlas and
    // library-cached textures are managed elsewhere
    if (o.userData.ownsMap) o.material?.map?.dispose?.()
    for (const m of [].concat(o.material)) m?.dispose?.()
  })
  g.removeFromParent()
}

function disposeBundle(b) {
  sceneApi.animators.delete(b.animator)
  disposeGroup(b.group)
  for (const t of b.atlasTextures) t.dispose()
  for (const t of b.markerTextures) t.dispose()
  b.sceneLight?.dispose()
}

function discardFull() {
  if (!fullBundle) return
  disposeBundle(fullBundle)
  fullBundle = null
}

// flips between the sliced root and the kept full build (the slicers' drag
// preview); false when there is no full build to show
function showFull(on) {
  if (!fullBundle || !root) return false
  fullBundle.group.visible = !!on
  root.visible = !on
  if (on) sceneApi.animators.add(fullBundle.animator)
  else sceneApi.animators.delete(fullBundle.animator)
  return true
}

// slicers all off: the kept full build becomes the primary again, no rebuild
function restoreFull() {
  if (!fullBundle || state.building) return false
  const old = root, oldTex = atlasTextures, oldMarkerTex = markerTextures, oldAnimator = animator, oldLight = sceneLight
  ;({ group: root, atlasTextures, markerTextures, animator, entityMarkers, doorByCell, sceneLight } = fullBundle)
  current.value = fullBundle.structure
  state.info = fullBundle.info
  root.visible = true
  sceneApi.contentRoots.add(root)
  sceneApi.syncAspect()
  sceneApi.animators.add(animator)
  fullBundle = null
  rootSliced = false
  if (old) {
    sceneApi.contentRoots.delete(old)
    sceneApi.animators.delete(oldAnimator)
    disposeGroup(old)
    for (const t of oldTex) t.dispose()
    for (const t of oldMarkerTex) t.dispose()
    oldLight?.dispose()
  }
  return true
}

// cancelling reverts to whatever was on screen: the flag is checked at every
// yield point, and abort() undoes the state build() had already claimed
let cancelBuild = false
function cancel() {
  if (!state.building) return
  cancelBuild = true
  state.status = "cancelling…"
}

// returns true when a build landed, false when it was cancelled. slice
// builds (from the slicers settling) cut the hidden blocks out for real
async function build(structure = source, refit = true, slice = false) {
  const assets = packs.assets.value
  if (!assets || !structure || state.building) return
  state.building = true
  cancelBuild = false
  lock(true)
  const prevCurrent = current.value, prevSource = source, prevHasSB = state.hasStructureBlocks, prevInfo = state.info
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
    // whether the show/hide toggle has anything to act on
    const techStates = new Set()
    structure.palette.forEach((e, i) => {
      if (e?.Name && (JIGSAW.test(e.Name) || SB.test(e.Name))) techStates.add(i)
    })
    state.hasStructureBlocks = techStates.size > 0 && structure.blocks.some(b => techStates.has(b.state))
    if (state.hideStructureBlocks) structure = stripStructureBlocks(structure)
    // a slice build drops the hidden blocks so the mesher produces solid cut
    // faces; the size (and so position and grid) stays the full structure's
    const unsliced = structure
    if (slice) structure = useSlicers().sliceStructure(structure)
    const slicedApplied = structure !== unsliced
    current.value = structure
    const lib = await loadLibrary()
    const [sx, sy, sz] = structure.size
    state.status = "building…"

    // per-block light: flood filled over the unsliced structure so cutaway
    // views keep the real interior darkness (and sliced-away torches still
    // glow). oversized scenes skip it rather than allocating a huge volume
    if (state.lighting === "world" && lib.computeSceneLight && (sx + 2) * (sy + 2) * (sz + 2) <= 48000000) {
      const lightBlocks = []
      for (const b of unsliced.blocks) {
        const e = unsliced.palette[b.state]
        if (!e?.Name || AIR.test(e.Name)) continue
        const name = LEGACY_RENAMES[e.Name.replace("minecraft:", "")] ?? e.Name
        lightBlocks.push({ id: name, properties: fixLegacyProps(name.replace("minecraft:", ""), e.Properties) ?? {}, pos: b.pos })
      }
      if (lightBlocks.length) {
        state.status = "lighting…"
        newLight = await lib.computeSceneLight(lightBlocks, { assets })
        if (cancelBuild) return abort()
        state.status = "building…"
      }
    }

    templates = new Map()
    nonSolid = new Set()
    collBoxCache = new Map()
    const isPlane = el => el.from[0] === el.to[0] || el.from[1] === el.to[1] || el.from[2] === el.to[2]
    async function template(stateIdx) {
      if (templates.has(stateIdx)) return templates.get(stateIdx)
      const entry = structure.palette[stateIdx]
      let tmpl = null
      if (entry && !AIR.test(entry.Name)) {
        const g = new THREE.Group()
        g.userData.daytime = daytimeUniform
        try {
          const name = LEGACY_RENAMES[entry.Name.replace("minecraft:", "")] ?? entry.Name
          const props = fixLegacyProps(name.replace("minecraft:", ""), entry.Properties)
          // __block only exists on loader-variant entries; plain blocks still
          // need one so the library can apply their in-game light emission
          const block = entry.__block ?? { id: name, properties: props ?? {} }
          // ignoreAtlases: real blocks, skip the per-texture atlas membership reads.
          // a model built only from flat planes (cross plants, vines, ladders,
          // rails) has no collision in game, so it shouldn't block the walker
          let any = false, allPlanes = true
          for (const model of await lib.parseBlockstate(assets, name, { data: props ?? {}, ignoreAtlases: true })) {
            const data = await lib.resolveModelData(assets, model)
            await lib.loadModel(g, assets, data, { display: {}, lighting: state.lighting, light: newLight, animate: false, fluidHeights: entry.__fluidHeights, block, neighbors: block.neighbors })
            for (const el of data?.elements ?? []) { any = true; if (!isPlane(el)) allPlanes = false }
          }
          if (any && allPlanes) nonSolid.add(stateIdx)
        } catch {}
        if (g.children.length) tmpl = g
      }
      templates.set(stateIdx, tmpl)
      return tmpl
    }

    // everything from here iterates real blocks only: air renders nothing,
    // and yielding across millions of air entries is genuinely slow
    const isAirState = structure.palette.map(e => !e?.Name || AIR.test(e.Name))
    const solid = []
    for (const b of structure.blocks) {
      if (!isAirState[b.state]) solid.push(b)
    }
    const total = solid.length

    // slow-build gate: with calibration the whole pipeline is estimable up
    // front; without it the template pass below self-samples. cancelling
    // reverts exactly like the cancel button
    const perfCal = loadPerf()
    let warnedOnce = false
    if (perfCal) {
      const estMs = total * (perfCal.b + perfCal.o)
      if (estMs > WARN_MS) {
        warnedOnce = true
        if (!await askWarn(estMs)) return abort()
      }
    }
    const tBuild = performance.now()

    // fluid surfaces shape themselves from their neighbourhood
    if (lib.fluidHeights) await remapFluidStates(structure, lib, assets)
    if (lib.ModelLoader) await remapLoaderStates(structure, lib, assets)

    // build every template up front (the optimiser reads them all)
    let placedCount = 0
    let sampleAt = null, tSample = 0
    state.progress = { phase: "build", done: 1500, total: 10000 }
    for (let i = 0; i < total; i++) {
      if (await template(solid[i].state)) placedCount++
      if (i % 400 === 399) {
        state.status = `building… ${i + 1}/${total}`
        state.progress = { phase: "build", done: 1500 + Math.round((i + 1) / total * 8500), total: 10000 }
        await yieldTask()
        if (cancelBuild) return abort()
        if (!warnedOnce && !perfCal) {
          // sample the marginal rate only after the cold start: template
          // building is per-state and front-loaded, so a cumulative average
          // projects absurd totals for palette-heavy scenes
          if (sampleAt === null) {
            if (performance.now() - tBuild > 400) {
              sampleAt = i + 1
              tSample = performance.now()
            }
          } else if (i + 1 - sampleAt >= 4000) {
            const rate = (i + 1 - sampleAt) / (performance.now() - tSample) // blocks per ms
            const elapsed = performance.now() - tBuild
            // the optimise pass usually dominates: assume 3x the template pass
            const projected = elapsed + (total - (i + 1)) / rate + 3 * total / rate
            if (projected > WARN_MS) {
              warnedOnce = true
              if (!await askWarn(projected)) return abort()
            } else {
              // fast enough: stop checking
              warnedOnce = true
            }
          }
        }
      }
    }
    state.progress = { phase: "build", done: 10000, total: 10000 }
    if (cancelBuild) return abort()

    // centre, snapped so every block fills a whole grid cell: templates are
    // block-centred, so a centre ≡ 8 (mod 16) keeps blocks on the lattice
    const gridCentre = v => Math.round((v - 8) / 16) * 16 + 8
    const position = new THREE.Vector3(gridCentre(-(sx - 1) * 8), gridCentre(-(sy - 1) * 8), gridCentre(-(sz - 1) * 8))
    newLight?.setOffset(position)

    // openable blocks render live (both models pre-built): keep them out of
    // the optimised static mesh
    const doorEntries = []
    for (const b of structure.blocks) {
      if (!isOpenable(structure.palette[b.state])) continue
      const openIdx = stateWithOpen(structure, b.state, "true")
      const closedIdx = stateWithOpen(structure, b.state, "false")
      await template(openIdx)
      await template(closedIdx)
      doorEntries.push({ b, openIdx, closedIdx })
      if (cancelBuild) return abort()
    }

    // canonical grouping: states whose single variant differs only by
    // blockstate rotation share an unrotated template; anything else (missing
    // model, multiple parts like waterlogged, uvlock rotation that bakes UVs)
    // falls back to its own per-state template with an identity rotation
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
              await lib.loadModel(g, assets, data, { display: {}, lighting: state.lighting, light: newLight, animate: false })
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

    const optStruct = doorEntries.length ? { ...structure, blocks: structure.blocks.filter(b => !isOpenable(structure.palette[b.state])) } : structure

    // culling must see the same renamed blocks that render: a legacy name
    // (grass_path) has no blockstate in modern packs, and the missing-model
    // fallback would occlude like a full cube
    function legacyCull(name, props) {
      const renamed = LEGACY_RENAMES[name.replace("minecraft:", "")] ?? name
      return [renamed, fixLegacyProps(renamed.replace("minecraft:", ""), props)]
    }
    const buildMs = performance.now() - tBuild
    const tOpt = performance.now()
    const opt = await optimise(optStruct, templates, position, {
      lib,
      getCullFaces: opts => {
        const [id, blockstates] = legacyCull(opts.id, opts.blockstates)
        const neighbors = {}
        for (const [dir, n] of Object.entries(opts.neighbors ?? {})) {
          const { id: nid, ...props } = n
          const [rid, rprops] = legacyCull(nid, props)
          neighbors[dir] = { id: rid, ...(rprops ?? {}) }
        }
        return lib.getCullFaces({ id, blockstates, neighbors, assets })
      },
      setStatus: s => { state.status = s },
      setProgress: (done, total) => { state.progress = { phase: "optimise", done, total } },
      shouldCancel: () => cancelBuild
    })
    if (!opt) return abort()
    // calibrate the estimator from real, completed passes; tiny builds are
    // all fixed cost and would poison the per-block rates
    if (total >= 2000) savePerf(buildMs / total, (performance.now() - tOpt) / total)
    const { group: next, atlasTextures: pending, drawCalls, tris } = opt

    // atomic swap: show the new group first, then drop the old one + its atlases
    const old = root, oldTex = atlasTextures, oldMarkerTex = markerTextures,
      oldAnimator = animator, oldMarkers = entityMarkers, oldDoors = doorByCell, oldLight = sceneLight
    root = next
    atlasTextures = pending
    sceneLight = newLight
    markerTextures = []
    sceneApi.scene.add(root)
    sceneApi.contentRoots.add(root)
    sceneApi.syncAspect()
    if (old) sceneApi.contentRoots.delete(old)
    if (animator) sceneApi.animators.delete(animator)
    const doorDraws = attachDoors(doorEntries)
    const entityDraws = await attachEntities(structure, lib, assets) + await attachSpawnerEggs(structure, lib, assets)
    try {
      const signs = await makeSignTexts(structure)
      if (signs) root.add(signs)
    } catch {}
    animator = lib.createAnimator(root)
    sceneApi.animators.add(animator)
    useSlicers().onBuild(root, position, [sx, sy, sz], slicedApplied)
    // one floor grid per structure part, hugging its footprint with a
    // 3-block border on every side
    const parts = structure.__parts ?? [{ off: [0, 0, 0], size: structure.size }]
    // a structure carrying a cave (mineshafts) gets a wireframe of the cave
    // volume, and the floor grid hides where it falls into the cave. the
    // cells are clipped to the grid footprint first so the outline closes
    // along the grid edge
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
      palette: templates.size,
      draws: drawCalls + doorDraws + entityDraws,
      tris
    }
    state.status = ""
    // a new source invalidates the kept full build, and a full build of the
    // same source supersedes it
    if (prevSource !== source || !slicedApplied) discardFull()
    if (slicedApplied && old && prevSource === source && !rootSliced && !fullBundle) {
      // the old root is the full build of this source: keep it hidden for
      // the slicers instead of disposing it
      old.visible = false
      fullBundle = {
        group: old, atlasTextures: oldTex, markerTextures: oldMarkerTex, animator: oldAnimator,
        structure: prevCurrent, info: prevInfo, entityMarkers: oldMarkers, doorByCell: oldDoors, sceneLight: oldLight
      }
    } else if (old) {
      disposeGroup(old)
      for (const t of oldTex) t.dispose()
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

watch(() => state.lighting, () => build(undefined, false))
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
    state, current, build, cancel, answerWarn, getRoot, getTemplates, getNonSolid, showFull, restoreFull,
    blockAt, blockEntryAt, boxForBlock, boxForEntity, markerUnderRay, rayHit, interact, aimDoor, currentBoxes, blockBoxes, exportCurrent
  }
}
