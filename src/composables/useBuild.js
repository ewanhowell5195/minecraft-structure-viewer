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
function remapFluidStates(structure, lib) {
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
    const h = lib.fluidHeights(type, (dx, dy, dz) => {
      const nb = byPos.get((bx + dx) + "," + (by + dy) + "," + (bz + dz))
      const ne = nb && structure.palette[nb.state]
      return ne?.Name ? { id: ne.Name, properties: ne.Properties } : null
    })
    const key = `${e.Name}|${JSON.stringify(e.Properties ?? null)}|${h.nw.toFixed(3)},${h.ne.toFixed(3)},${h.sw.toFixed(3)},${h.se.toFixed(3)}|${h.full ? 1 : 0}|${h.angle == null ? "" : h.angle.toFixed(2)}`
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
  collect: false,
  placedCount: 0,
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

// collect mode: committed structures stay in the scene beside the current one
let placed = []
let sceneRight = 0 // world-space right edge of everything placed
let offsetX = 0    // x centre of the current build (0 unless collecting)

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

// openable blocks render as ONE InstancedMesh per unique state per template
// mesh, not per-block clone groups: a build with hundreds of trapdoors was
// thousands of draw calls. a hidden instance is collapsed to zero scale, so
// toggling stays a matrix write with no rebuild
let doorSlots = new Map() // stateIdx -> { entries, meshes: InstancedMesh[], box }
const _dm = new THREE.Matrix4()
const _dzero = new THREE.Matrix4().makeScale(0, 0, 0)


function setDoorInstance(stateIdx, slot, pos, visible) {
  const s = doorSlots.get(stateIdx)
  if (!s) return
  for (const im of s.meshes) {
    if (visible) im.setMatrixAt(slot, _dm.makeTranslation(pos[0] * 16, pos[1] * 16, pos[2] * 16).multiply(im.userData.baseMatrix))
    else im.setMatrixAt(slot, _dzero)
    im.instanceMatrix.needsUpdate = true
  }
}

function attachDoors(entries) {
  const structure = current.value
  doorByCell = new Map()
  doorSlots = new Map()
  if (!entries.length) return 0
  // an instance slot per placement of each open/closed state
  const slotFor = (e, stateIdx) => {
    let s = doorSlots.get(stateIdx)
    if (!s) doorSlots.set(stateIdx, s = { count: 0, meshes: [], box: null })
    return s.count++
  }
  for (const e of entries) {
    e.openSlot = slotFor(e, e.openIdx)
    e.closedSlot = slotFor(e, e.closedIdx)
  }
  let draws = 0
  for (const [stateIdx, s] of doorSlots) {
    const tmpl = templates.get(stateIdx)
    if (!tmpl) continue
    tmpl.updateMatrixWorld(true)
    s.box = new THREE.Box3().setFromObject(tmpl)
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

// march the look ray; return the first openable block within reach (or
// null), stopping at a solid wall so you can't reach through it
const _aimBox = new THREE.Box3()
function rayDoor(ox, oy, oz, dx, dy, dz) {
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
    if (reg) return reg
    const i = idx.get(key)
    if (i == null) continue
    if (!AIR.test(structure.palette[structure.blocks[i].state]?.Name || "")) return null
  }
  return null
}

// toggle the door being looked at; returns whether anything changed
function interact(ox, oy, oz, dx, dy, dz) {
  const reg = rayDoor(ox, oy, oz, dx, dy, dz)
  if (!reg) return false
  toggleDoor(reg)
  return true
}

// world-space box of the door being looked at (for the in-reach outline)
const _aimV = new THREE.Vector3()
function aimDoor(ox, oy, oz, dx, dy, dz) {
  const reg = rayDoor(ox, oy, oz, dx, dy, dz)
  if (!reg) return null
  const structure = current.value
  const open = structure.palette[reg.b.state].Properties.open === "true"
  const s = doorSlots.get(open ? reg.openIdx : reg.closedIdx)
  if (!s?.box) return null
  return _aimBox.copy(s.box).translate(_aimV.set(reg.b.pos[0] * 16, reg.b.pos[1] * 16, reg.b.pos[2] * 16).add(root.position))
}

// the current structure keeps ownership of its group, animator, textures and
// collision boxes only until it is committed: after this the next build's
// atomic swap has nothing to remove or dispose
function commitCurrent() {
  const box = new THREE.Box3().setFromObject(root)
  sceneRight = placed.length ? Math.max(sceneRight, box.max.x) : box.max.x
  placed.push({ group: root, animator, textures: atlasTextures, boxes: rawBoxes() })
  state.placedCount = placed.length
  root = null
  animator = null
  atlasTextures = []
  doorByCell = new Map()
}

function clearPlaced() {
  for (const p of placed) {
    sceneApi.contentRoots.delete(p.group)
    sceneApi.animators.delete(p.animator)
    disposeGroup(p.group)
    for (const t of p.textures) t.dispose()
  }
  placed = []
  state.placedCount = 0
  sceneRight = 0
}

// clear button: drop every placed structure and rebuild the current one back
// at the origin
async function clearCollected() {
  if (state.building) return
  clearPlaced()
  if (source) await build()
  else sceneApi.remakeGrid()
}

// real world-space collision AABBs of the current structure: one per template
// mesh (a stair yields its stepped boxes, a slab a half box), per block
function rawBoxes() {
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

// walk collision spans the whole scene: placed structures too
function currentBoxes() {
  const out = []
  for (const p of placed) out.push(...p.boxes)
  out.push(...rawBoxes())
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

// replace: the structure object is fresh but stands in for the current one
// (pack swap re-read), so it must not count as a new load
async function build(structure = source, refit = true, replace = false) {
  const assets = packs.assets.value
  if (!assets || !structure || state.building) return
  const isNew = !replace && structure !== source
  state.building = true
  lock(true)
  try {
    if (isNew) {
      if (state.collect && root) commitCurrent()
      else if (!state.collect) clearPlaced()
    }
    source = structure
    if (state.hideStructureBlocks) structure = stripStructureBlocks(structure)
    current.value = structure
    const lib = await loadLibrary()
    const [sx, sy, sz] = structure.size
    state.status = "building…"

    // collecting lays structures out left to right with a 2-block gap;
    // rebuilds in place keep their spot
    offsetX = placed.length ? (isNew ? sceneRight + 32 + sx * 8 : offsetX) : 0

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
    if (lib.fluidHeights) remapFluidStates(structure, lib)

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
    const position = new THREE.Vector3(gridCentre(offsetX - (sx - 1) * 8), gridCentre(-(sy - 1) * 8), gridCentre(-(sz - 1) * 8))

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
    sceneApi.remakeGrid()
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
    await exportScene({ format, name, root, placed })
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
    blockAt, interact, aimDoor, currentBoxes, clearCollected, exportCurrent
  }
}
