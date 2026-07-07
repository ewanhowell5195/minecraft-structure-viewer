import { reactive, readonly, shallowRef, watch } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useScene } from "./useScene.js"
import { useLock } from "./useLock.js"
import { optimise } from "../optimise.js"
import { exportScene } from "../export.js"

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

const state = reactive({
  lighting: "world",
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

// clone both models of each openable block onto the fresh root, show the one
// matching its state, index by cell with door halves linked
function attachDoors(entries) {
  const structure = current.value
  doorByCell = new Map()
  for (const { b, openIdx, closedIdx } of entries) {
    const mk = stateIdx => {
      const t = templates.get(stateIdx)
      if (!t) return null
      const g = t.clone()
      g.position.set(b.pos[0] * 16, b.pos[1] * 16, b.pos[2] * 16)
      root.add(g)
      return g
    }
    const open = structure.palette[b.state].Properties.open === "true"
    const gOpen = mk(openIdx), gClosed = mk(closedIdx)
    if (gOpen) gOpen.visible = open
    if (gClosed) gClosed.visible = !open
    doorByCell.set(b.pos.join(","), { b, openIdx, closedIdx, gOpen, gClosed, pair: null })
  }
  for (const reg of doorByCell.values()) {
    if (!isDoorName(structure.palette[reg.b.state].Name)) continue
    const [x, y, z] = reg.b.pos
    reg.pair = doorByCell.get(x + "," + (y + 1) + "," + z) || doorByCell.get(x + "," + (y - 1) + "," + z) || null
  }
}

// flip an openable block (and the other door half): swap visibility and
// repoint its state so collision boxes follow
function toggleDoor(reg) {
  const structure = current.value
  const open = structure.palette[reg.b.state].Properties.open !== "true"
  for (const r of reg.pair ? [reg, reg.pair] : [reg]) {
    r.b.state = open ? r.openIdx : r.closedIdx
    if (r.gOpen) r.gOpen.visible = open
    if (r.gClosed) r.gClosed.visible = !open
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
function aimDoor(ox, oy, oz, dx, dy, dz) {
  const reg = rayDoor(ox, oy, oz, dx, dy, dz)
  if (!reg) return null
  const g = reg.gOpen?.visible ? reg.gOpen : reg.gClosed
  return g ? _aimBox.setFromObject(g) : null
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
  if (current.value) await build(current.value)
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
    o.geometry?.dispose()
    for (const m of [].concat(o.material)) m?.dispose?.()
  })
  g.removeFromParent()
}

// replace: the structure object is fresh but stands in for the current one
// (pack swap re-read), so it must not count as a new load
async function build(structure = current.value, refit = true, replace = false) {
  const assets = packs.assets.value
  if (!assets || !structure || state.building) return
  const isNew = !replace && structure !== current.value
  state.building = true
  lock(true)
  try {
    if (isNew) {
      if (state.collect && root) commitCurrent()
      else if (!state.collect) clearPlaced()
    }
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
            await lib.loadModel(g, assets, data, { display: {}, lighting: state.lighting, animate: false })
            for (const el of data?.elements ?? []) { any = true; if (!isPlane(el)) allPlanes = false }
          }
          if (any && allPlanes) nonSolid.add(stateIdx)
        } catch {}
        if (g.children.length) tmpl = g
      }
      templates.set(stateIdx, tmpl)
      return tmpl
    }

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

    const { group: next, atlasTextures: pending, tris } = await optimise(optStruct, templates, position, {
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
    attachDoors(doorEntries)
    animator = lib.createAnimator(root)
    sceneApi.animators.add(animator)
    sceneApi.remakeGrid()
    if (refit) sceneApi.fit()
    state.info = {
      size: `${sx}×${sy}×${sz}`,
      blocks: placedCount,
      palette: templates.size,
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

watch(() => state.lighting, () => { if (current.value) build(current.value, false) })

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
