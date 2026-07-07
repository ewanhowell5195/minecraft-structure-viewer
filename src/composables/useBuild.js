import { reactive, readonly, shallowRef, watch } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useScene } from "./useScene.js"
import { useLock } from "./useLock.js"
import { optimise } from "../optimise.js"
import { exportScene } from "../export.js"
import { JIGSAW, parseState } from "../transforms.js"

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
  const isTech = b => {
    const n = structure.palette[b.state]?.Name || ""
    return JIGSAW.test(n) || SB.test(n)
  }
  if (!structure.blocks.some(isTech)) return structure
  const palette = structure.palette.slice()
  const idx = new Map()
  const stateFor = e => {
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
// cells (open water, full columns) still share one template
const FLUID_RE = /(^|:)(water|flowing_water|lava|flowing_lava)$/
async function remapFluidStates(structure, lib, assets) {
  const byPos = new Map()
  for (const b of structure.blocks) byPos.set(b.pos.join(","), b)
  const byKey = new Map()
  structure.palette.forEach((e, i) => { if (e?.__fluidKey) byKey.set(e.__fluidKey, i) })
  for (const b of structure.blocks) {
    const e = structure.palette[b.state]
    if (!e?.Name) continue
    const type = FLUID_RE.test(e.Name) ? (/lava/.test(e.Name) ? "lava" : "water")
      : e.Properties?.waterlogged === "true" ? "water" : null
    if (!type) continue
    const [bx, by, bz] = b.pos
    const h = await lib.fluidHeights(assets, type, (dx, dy, dz) => {
      const nb = byPos.get((bx + dx) + "," + (by + dy) + "," + (bz + dz))
      const ne = nb && structure.palette[nb.state]
      return ne?.Name ? { id: ne.Name, properties: ne.Properties } : null
    })
    const ov = h.overlay ? (h.overlay.north ? "n" : "") + (h.overlay.south ? "s" : "") + (h.overlay.east ? "e" : "") + (h.overlay.west ? "w" : "") : ""
    const key = `${e.Name}|${JSON.stringify(e.Properties ?? null)}|${h.nw.toFixed(3)},${h.ne.toFixed(3)},${h.sw.toFixed(3)},${h.se.toFixed(3)}|${h.full ? 1 : 0}|${h.angle == null ? "" : h.angle.toFixed(2)}|${ov}`
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

const state = reactive({
  lighting: "world",
  hideStructureBlocks: localStorage.getItem("hideStructureBlocks") !== "false",
  hasStructureBlocks: false,
  building: false,
  status: "",
  info: null
})

// ---- openable blocks (doors/trapdoors/gates): never baked into the merged
// mesh. both open + closed models are pre-built and a toggle just flips which
// clone is visible, so no rebuild is needed.
const OPENABLE = /(^|:)([a-z_]+_)?(door|trapdoor|fence_gate)$/
const isDoorName = name => /(^|:)([a-z_]+_)?door$/.test(name) && !/trapdoor$/.test(name)
const isOpenable = e => !!(e?.Properties && "open" in e.Properties && OPENABLE.test(e.Name || ""))
const sameProps = (a, b) => {
  const ka = Object.keys(a || {})
  if (ka.length !== Object.keys(b || {}).length) return false
  return ka.every(k => a[k] === b[k])
}

const current = shallowRef(null)
let source = null // the structure as loaded/combined; current may be a display strip of it
let root = null
let animator = null
let templates = null
let nonSolid = new Set()
let atlasTextures = [] // the displayed atlases; swapped + disposed on rebuild
let doorByCell = new Map()
let blockMap = null, blockMapFor = null

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
  const slotFor = stateIdx => {
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

// flip an openable block (and the other door half): swap the instance
// matrices and repoint its state so collision boxes follow
function toggleDoor(reg) {
  const structure = current.value
  const open = structure.palette[reg.b.state].Properties.open !== "true"
  for (const r of reg.pair ? [reg, reg.pair] : [reg]) {
    r.b.state = open ? r.openIdx : r.closedIdx
    setDoorInstance(r.openIdx, r.openSlot, r.b.pos, open)
    setDoorInstance(r.closedIdx, r.closedSlot, r.b.pos, !open)
  }
}

// march the look ray; return the first interactable block within reach:
// an openable ({ door }) or a loot container ({ container }). stops at a
// solid wall so you can't reach through it
const _aimBox = new THREE.Box3()
function rayHit(ox, oy, oz, dx, dy, dz) {
  const structure = current.value
  if (!structure || !root) return null
  const idx = cellIndex(), REACH = 80
  let last = ""
  for (let t = 2; t <= REACH; t += 2) {
    const [bx, by, bz] = cellOf(ox + dx * t, oy + dy * t, oz + dz * t)
    const key = bx + "," + by + "," + bz
    if (key === last) continue
    last = key
    const reg = doorByCell.get(key)
    if (reg) return { door: reg }
    const i = idx.get(key)
    if (i == null) continue
    const b = structure.blocks[i]
    if (b.nbt?.LootTable) return { container: b }
    if (!AIR.test(structure.palette[b.state]?.Name || "")) return null
  }
  return null
}

// act on the block being looked at: toggles a door (true), hands back a
// loot container block, or false when there is nothing in reach
function interact(ox, oy, oz, dx, dy, dz) {
  const h = rayHit(ox, oy, oz, dx, dy, dz)
  if (h?.door) {
    toggleDoor(h.door)
    return true
  }
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
  return h ? boxForBlock(h.door ? h.door.b : h.container) : null
}

// the raw structure block at a world position (orbit-mode picking)
function blockEntryAt(wx, wy, wz) {
  const structure = current.value
  if (!structure || !root) return null
  const [bx, by, bz] = cellOf(wx, wy, wz)
  const i = cellIndex().get(bx + "," + by + "," + bz)
  return i == null ? null : structure.blocks[i]
}

// real world-space collision AABBs of the current structure: one per template
// mesh (a stair yields its stepped boxes, a slab a half box), per block
function currentBoxes() {
  const structure = current.value
  const out = []
  if (!structure || !root || !templates) return out
  const p = root.position
  const cache = new Map(), _b = new THREE.Box3()
  const localBoxes = tmpl => {
    let arr = cache.get(tmpl)
    if (arr) return arr
    arr = []
    tmpl.updateMatrixWorld(true)
    tmpl.traverse(o => {
      if (!o.isMesh) return
      _b.setFromObject(o)
      if (!_b.isEmpty()) arr.push([_b.min.x, _b.min.y, _b.min.z, _b.max.x, _b.max.y, _b.max.z])
    })
    cache.set(tmpl, arr)
    return arr
  }
  for (const b of structure.blocks) {
    if (nonSolid.has(b.state)) continue
    const tmpl = templates.get(b.state)
    if (!tmpl) continue
    const ox = p.x + b.pos[0] * 16, oy = p.y + b.pos[1] * 16, oz = p.z + b.pos[2] * 16
    for (const l of localBoxes(tmpl)) out.push({ nx: l[0] + ox, ny: l[1] + oy, nz: l[2] + oz, px: l[3] + ox, py: l[4] + oy, pz: l[5] + oz })
  }
  return out
}


function disposeGroup(g) {
  if (!g) return
  g.traverse(o => {
    if (!o.isMesh || o.userData.shared) return
    if (o.isInstancedMesh) o.dispose()
    o.geometry?.dispose()
    for (const m of [].concat(o.material)) m?.dispose?.()
  })
  g.removeFromParent()
}

async function build(structure = source, refit = true) {
  const assets = packs.assets.value
  if (!assets || !structure || state.building) return
  state.building = true
  lock(true)
  try {
    source = structure
    // whether the show/hide toggle has anything to act on
    const techStates = new Set()
    structure.palette.forEach((e, i) => {
      if (e?.Name && (JIGSAW.test(e.Name) || SB.test(e.Name))) techStates.add(i)
    })
    state.hasStructureBlocks = techStates.size > 0 && structure.blocks.some(b => techStates.has(b.state))
    if (state.hideStructureBlocks) structure = stripStructureBlocks(structure)
    current.value = structure
    const lib = await loadLibrary()
    const [sx, sy, sz] = structure.size
    state.status = "building…"

    templates = new Map()
    nonSolid = new Set()
    const isPlane = el => el.from[0] === el.to[0] || el.from[1] === el.to[1] || el.from[2] === el.to[2]
    async function template(stateIdx) {
      if (templates.has(stateIdx)) return templates.get(stateIdx)
      const entry = structure.palette[stateIdx]
      let tmpl = null
      if (entry && !AIR.test(entry.Name)) {
        const g = new THREE.Group()
        try {
          const name = LEGACY_RENAMES[entry.Name.replace("minecraft:", "")] ?? entry.Name
          const props = fixLegacyProps(name.replace("minecraft:", ""), entry.Properties)
          // ignoreAtlases: real blocks, skip the per-texture atlas membership reads.
          // a model built only from flat planes (cross plants, vines, ladders,
          // rails) has no collision in game, so it shouldn't block the walker
          let any = false, allPlanes = true
          for (const model of await lib.parseBlockstate(assets, name, { data: props ?? {}, ignoreAtlases: true })) {
            const data = await lib.resolveModelData(assets, model)
            await lib.loadModel(g, assets, data, { display: {}, lighting: state.lighting, animate: false, fluidHeights: entry.__fluidHeights })
            for (const el of data?.elements ?? []) { any = true; if (!isPlane(el)) allPlanes = false }
          }
          if (any && allPlanes) nonSolid.add(stateIdx)
        } catch {}
        if (g.children.length) tmpl = g
      }
      templates.set(stateIdx, tmpl)
      return tmpl
    }

    // fluid surfaces shape themselves from their neighbourhood
    if (lib.fluidHeights) await remapFluidStates(structure, lib, assets)

    // build every template up front (the optimiser reads them all)
    let placedCount = 0
    for (let i = 0; i < structure.blocks.length; i++) {
      if (await template(structure.blocks[i].state)) placedCount++
      if (i % 400 === 399) {
        state.status = `building… ${i + 1}/${structure.blocks.length}`
        await new Promise(r => setTimeout(r))
      }
    }

    // centre, snapped so every block fills a whole grid cell: templates are
    // block-centred, so a centre ≡ 8 (mod 16) keeps blocks on the lattice
    const gridCentre = v => Math.round((v - 8) / 16) * 16 + 8
    const position = new THREE.Vector3(gridCentre(-(sx - 1) * 8), gridCentre(-(sy - 1) * 8), gridCentre(-(sz - 1) * 8))

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
              const data = await lib.resolveModelData(assets, { ...m, x: 0, y: 0, z: 0 })
              await lib.loadModel(g, assets, data, { display: {}, lighting: state.lighting, animate: false })
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

    const { group: next, atlasTextures: pending, drawCalls, tris } = await optimise(optStruct, templates, position, {
      getCullFaces: opts => lib.getCullFaces({ ...opts, assets }),
      setStatus: s => { state.status = s }
    })

    // atomic swap: show the new group first, then drop the old one + its atlases
    const old = root, oldTex = atlasTextures
    root = next
    atlasTextures = pending
    sceneApi.scene.add(root)
    sceneApi.contentRoots.add(root)
    if (old) sceneApi.contentRoots.delete(old)
    if (animator) sceneApi.animators.delete(animator)
    const doorDraws = attachDoors(doorEntries)
    animator = lib.createAnimator(root)
    sceneApi.animators.add(animator)
    // one floor grid per structure part, hugging its footprint with a 3-block
    // border (4 on one side when needed to keep the size even, so the centre
    // cross lands on a block boundary)
    const parts = structure.__parts ?? [{ off: [0, 0, 0], size: structure.size }]
    sceneApi.setGrids(parts.map(p => {
      const gw = p.size[0] + 6 + (p.size[0] % 2), gd = p.size[2] + 6 + (p.size[2] % 2)
      return {
        x: position.x + (p.off[0] - 3) * 16 - 8,
        z: position.z + (p.off[2] - 3) * 16 - 8,
        y: position.y + p.off[1] * 16 - 8.01,
        w: gw,
        d: gd,
        label: p.name
      }
    }))
    if (refit) sceneApi.fit()
    state.info = {
      size: `${sx}×${sy}×${sz}`,
      blocks: placedCount,
      palette: templates.size,
      draws: drawCalls + doorDraws,
      tris
    }
    state.status = ""
    disposeGroup(old)
    for (const t of oldTex) t.dispose()
  } finally {
    state.building = false
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
    state, current, build, getRoot, getTemplates, getNonSolid,
    blockAt, blockEntryAt, boxForBlock, interact, aimDoor, currentBoxes, exportCurrent
  }
}
