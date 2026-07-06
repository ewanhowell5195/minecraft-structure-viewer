import { reactive, readonly, shallowRef, watch } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useScene } from "./useScene.js"
import { useLock } from "./useLock.js"
import { optimise } from "../optimise.js"

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
  building: false,
  status: "",
  info: null
})

const current = shallowRef(null)
let root = null
let animator = null
let templates = null
let nonSolid = new Set()
let atlasTextures = [] // the displayed atlases; swapped + disposed on rebuild

function disposeGroup(g) {
  if (!g) return
  g.traverse(o => {
    if (!o.isMesh || o.userData.shared) return
    o.geometry?.dispose()
    for (const m of [].concat(o.material)) m?.dispose?.()
  })
  g.removeFromParent()
}

// per-template draw-call + triangle counts, summed over placements
function stat(t) {
  let dc = 0, tris = 0
  t.traverse(o => {
    if (!o.isMesh) return
    const mats = [].concat(o.material)
    const gs = o.geometry.groups.length ? o.geometry.groups : [{ count: o.geometry.index.count, materialIndex: 0 }]
    for (const g of gs) {
      const m = mats[g.materialIndex]
      if (m && m.visible !== false) { dc++; tris += g.count / 3 }
    }
  })
  return { dc, tris }
}

async function build(structure = current.value, refit = true) {
  const assets = packs.assets.value
  if (!assets || !structure || state.building) return
  current.value = structure
  state.building = true
  lock(true)
  try {
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

    // build every template up front (the optimiser reads them all) and sum
    // per-placement stats for the raw -> optimised readout
    const tstat = new Map()
    let placedCount = 0, rawDc = 0, rawTris = 0
    for (let i = 0; i < structure.blocks.length; i++) {
      const b = structure.blocks[i]
      const tmpl = await template(b.state)
      if (tmpl) {
        placedCount++
        let s = tstat.get(b.state)
        if (s === undefined) tstat.set(b.state, s = stat(tmpl))
        rawDc += s.dc; rawTris += s.tris
      }
      if (i % 400 === 399) {
        state.status = `building… ${i + 1}/${structure.blocks.length}`
        await new Promise(r => setTimeout(r))
      }
    }

    // centre, snapped so every block fills a whole grid cell: templates are
    // block-centred, so a centre ≡ 8 (mod 16) keeps blocks on the lattice
    const gridCentre = v => Math.round((v - 8) / 16) * 16 + 8
    const position = new THREE.Vector3(gridCentre(-(sx - 1) * 8), gridCentre(-(sy - 1) * 8), gridCentre(-(sz - 1) * 8))

    const { group: next, atlasTextures: pending, drawCalls: optDc, tris: optTris } = await optimise(structure, templates, position, {
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
    animator = lib.createAnimator(root)
    sceneApi.animators.add(animator)
    sceneApi.remakeGrid()
    if (refit) sceneApi.fit()
    state.info = {
      size: `${sx}×${sy}×${sz}`,
      blocks: placedCount,
      palette: templates.size,
      rawDc, rawTris, optDc, optTris
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

const getRoot = () => root
const getTemplates = () => templates
const getNonSolid = () => nonSolid

export function useBuild() {
  return { state, current, build, getRoot, getTemplates, getNonSolid }
}
