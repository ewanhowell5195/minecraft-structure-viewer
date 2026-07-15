import { reactive, readonly } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useStructures } from "./useStructures.js"
import { useBuild } from "./useBuild.js"
import { useScene } from "./useScene.js"
import { useLock } from "./useLock.js"
import { readStructure } from "../nbt.js"
import { AIR, EMPTY, JIGSAW, mix, parseState, poolTemplates, rand32, rnd } from "../transforms.js"
import { hasDataMarkers, processDataMarkers } from "../markers.js"
import { runJigsaw } from "../jigsaw.js"
import { mineshaftPieceGens, rerollGen, runDesertPyramid, runDesertWell, runDungeon, runEndCity, runEndSpikes, runEndSpikesActive, runFortress, runIgloo, runJungleTemple, runMansion, runMineshaft, runMineshaftMesa, runMonument, runStronghold } from "../generators/index.js"
import { PROC } from "../proc.js"

// level is 0-based (the UI shows level + 1). the base is seedless; a seed rolls
// on the first ascent off it and stays fixed until you return to the base
const packs = usePacks()
const structures = useStructures()
const buildApi = useBuild()
const sceneApi = useScene()
const { lock, locked } = useLock()

const state = reactive({
  active: false,
  kind: null,
  label: "Structure Blocks",
  steps: true,
  reroll: false,
  level: 0,
  maxDepth: 7,
  seed: null,
  solving: false
})

let base = null, baseName = null
let baseRadius = 96
// the generator's own depth cap; data markers add one processing level past it
let genCap = Infinity
let prevAnchorWorld = null

// adopted by the FIRST session only; captured up front because loads rewrite the query string
let urlSeed = null, urlLevel = null
{
  const sp = new URLSearchParams(location.search)
  const hex = sp.get("seed")
  if (hex && /^[0-9a-f]{1,8}$/i.test(hex)) {
    urlSeed = parseInt(hex, 16) >>> 0
    const lvl = parseInt(sp.get("level"))
    urlLevel = Number.isFinite(lvl) ? lvl : 2
  }
}

function nsSplit(ref) {
  const i = ref.indexOf(":")
  return i < 0 ? ["minecraft", ref] : [ref.slice(0, i), ref.slice(i + 1)]
}

async function loadStruct(ref) {
  const [ns, path] = nsSplit(ref)
  const zp = structures.zipPathOf(ns + "/" + path)
  if (!zp) return null
  const lib = await loadLibrary()
  const buf = await lib.readFile(zp, packs.assets.value)
  return buf ? readStructure(buf) : null
}

async function loadPool(ref) {
  const [ns, path] = nsSplit(ref)
  const lib = await loadLibrary()
  const buf = await lib.readFile(`data/${ns}/worldgen/template_pool/${path}.json`, packs.assets.value)
  return buf ? JSON.parse(new TextDecoder().decode(buf)) : null
}

const generators = {
  igloo: runIgloo, end_city: runEndCity, mansion: runMansion,
  jungle_temple: runJungleTemple, desert_pyramid: runDesertPyramid, desert_well: runDesertWell, dungeon: runDungeon,
  dungeon_7x5: rerollGen("minecraft/builtin/dungeon/7x5"),
  dungeon_5x7: rerollGen("minecraft/builtin/dungeon/5x7"),
  dungeon_7x7: rerollGen("minecraft/builtin/dungeon/7x7"),
  fortress: runFortress, end_spikes: runEndSpikes, end_spikes_active: runEndSpikesActive, stronghold: runStronghold,
  mineshaft: runMineshaft, mineshaft_mesa: runMineshaftMesa, monument: runMonument,
  ...mineshaftPieceGens
}

async function resolve(level) {
  const gl = Math.min(level, genCap)
  let res
  if (gl === 0 || !base) res = { structure: base }
  else if (state.kind === "jigsaw") {
    // maxRadius mirrors the game's max_distance_from_center; the piece cap is a runaway backstop vanilla lacks
    res = await runJigsaw(base, {
      loadStruct, loadPool,
      maxDepth: gl, maxPieces: 1024, maxRadius: baseRadius,
      levelSeed: l => mix(state.seed, l),
      onProgress: n => { buildApi.state.status = `loading… ${n} pieces` },
      // at the depth cap the frontier's jigsaws are consumed, like vanilla's finished generation
      keepJigsaws: gl < genCap
    })
  } else {
    const gen = generators[state.kind]
    res = gen ? await gen(loadStruct, { maxDepth: gl, seed: state.seed }) : { structure: base }
  }
  // stepless sessions have no way to reach a bonus level, so they process inline
  if ((level > gl || (!state.steps && gl > 0)) && res.structure && hasDataMarkers(res.structure, baseName)) {
    res = { ...res, structure: processDataMarkers(res.structure, baseName, rnd(mix(state.seed ?? 1, 0x5f375a86))) }
  }
  return res
}

// each build re-centres the assembly, so the camera shifts by however far the base's anchor moved
async function regenerate() {
  state.solving = true
  try {
    let structure
    try {
      const res = await resolve(state.level)
      structure = res.structure
      // a solve that stops short IS at max depth (deeper levels re-solve identically);
      // floor 1, not the deepest piece: even an empty round consumed the base's jigsaws
      if (state.kind === "jigsaw" && (res.exhausted || res.capped || res.depth < Math.min(state.level, genCap))) {
        genCap = Math.max(res.depth, 1)
        state.maxDepth = genCap
        if (state.level > state.maxDepth) state.level = state.maxDepth
      }
      // reaching the generator's cap with markers still present unlocks one more step
      if (state.steps && state.kind !== "markers" && state.level === genCap && state.maxDepth === genCap && hasDataMarkers(structure, baseName)) {
        state.maxDepth = genCap + 1
      }
    } catch (err) {
      buildApi.state.status = `couldn't assemble: ${err}`
      return
    }
    await buildApi.build(structure, false)
    const root = buildApi.getRoot()
    const a = structure.anchor ?? [0, 0, 0]
    const aw = new THREE.Vector3(a[0] * 16, a[1] * 16, a[2] * 16).add(root.position)
    if (prevAnchorWorld) {
      const delta = aw.clone().sub(prevAnchorWorld)
      sceneApi.camera.position.add(delta)
      sceneApi.controls.target.add(delta)
      sceneApi.controls.update()
    }
    prevAnchorWorld = aw
  } finally {
    state.solving = false
  }
  syncUrl()
}

function syncUrl() {
  const u = new URL(location)
  if (state.active && state.level > 0 && state.seed != null) {
    if (baseName && !u.searchParams.get("structure")) u.searchParams.set("structure", baseName)
    u.searchParams.set("seed", state.seed.toString(16))
    u.searchParams.set("level", String(state.level + 1))
  } else {
    u.searchParams.delete("seed")
    u.searchParams.delete("level")
  }
  history.replaceState(null, "", u)
}

async function setLevel(target, { freshSeed = false } = {}) {
  if (target > 0 && (freshSeed || state.seed == null)) {
    state.seed = rand32()
    if (state.kind === "jigsaw") {
      genCap = structures.getStructDepth(baseName) ?? genCap
      state.maxDepth = genCap
      baseRadius = structures.getStructRadius(baseName) ?? baseRadius
    }
    else if (state.steps) await probeDepth()
  }
  target = Math.max(0, Math.min(target, state.maxDepth))
  if (target === 0) state.seed = null
  state.level = target
  await regenerate()
}

const op = fn => async (...args) => {
  if (locked.value || !state.active) return
  lock(true)
  try { await fn(...args) } finally { lock(false) }
}
const next = op(() => setLevel(state.level + 1))
const all = op(async () => {
  await setLevel(Infinity)
  // a marker level unlocked by reaching the generator cap counts as "all"
  if (state.level < state.maxDepth) await setLevel(Infinity)
})
const undo = op(() => setLevel(state.level - 1))
const reset = op(() => setLevel(0))
const reloadAll = op(() => setLevel(state.level, { freshSeed: true }))
const fullReload = op(() => setLevel(Infinity, { freshSeed: true }))
const generate = fullReload

async function probeDepth() {
  const gen = generators[state.kind]
  if (!gen || state.seed == null) return
  const { maxDepth } = await gen(loadStruct, { maxDepth: Infinity, seed: state.seed })
  if (typeof maxDepth === "number") {
    genCap = maxDepth
    state.maxDepth = maxDepth
  }
}

// village animal spawner pieces (empty pool, structure_void final_state) would
// otherwise get a session with no real levels
async function jigsawsCanAct(structure) {
  for (const b of structure.blocks) {
    if (!JIGSAW.test(structure.palette[b.state]?.Name || "")) continue
    const fs = parseState(typeof b.nbt?.final_state === "string" ? b.nbt.final_state : "")
    if (!AIR.test(fs.Name)) return true
    let ref = typeof b.nbt?.pool === "string" ? b.nbt.pool : null
    const seen = new Set()
    while (ref && !seen.has(ref)) {
      seen.add(ref)
      const pool = await loadPool(ref).catch(() => null)
      if (!pool) break
      if (poolTemplates(pool).some(t => t !== EMPTY)) return true
      ref = typeof pool.fallback === "string" ? pool.fallback : null
    }
  }
  return false
}

async function startSession(structure, name) {
  base = structure
  baseName = name
  prevAnchorWorld = null
  const proc = PROC.find(p => p.entry === name)
  const isJigsaw = structure.palette.some(e => JIGSAW.test(e?.Name || ""))
  if (proc && generators[proc.gen]) {
    state.kind = proc.gen
    state.label = proc.label
    state.steps = proc.steps
    state.reroll = !!proc.reroll
    genCap = proc.maxDepth ?? 1
    state.maxDepth = genCap
  } else if (isJigsaw && await jigsawsCanAct(structure)) {
    state.kind = "jigsaw"
    state.label = "Structure Blocks"
    state.steps = true
    state.reroll = false
    await structures.computeWorldgen()
    // pieces with no structure def get generous caps the stop-short clamp
    // shrinks; 128 is the codec max radius
    genCap = structures.getStructDepth(name) ?? 20
    state.maxDepth = genCap
    baseRadius = structures.getStructRadius(name) ?? 128
  } else if (hasDataMarkers(structure, name)) {
    state.kind = "markers"
    state.label = "Structure Blocks"
    state.steps = true
    state.reroll = false
    genCap = 0
    state.maxDepth = 1
  } else {
    endSession()
    return
  }
  state.level = 0
  state.seed = null
  state.active = true
  const root = buildApi.getRoot()
  if (root) {
    const a = structure.anchor ?? [0, 0, 0]
    prevAnchorWorld = new THREE.Vector3(a[0] * 16, a[1] * 16, a[2] * 16).add(root.position)
  }

  if (urlSeed != null) {
    state.seed = urlSeed
    state.level = state.steps ? Math.max(1, Math.min(urlLevel - 1, state.maxDepth)) : state.maxDepth
    urlSeed = urlLevel = null
    await regenerate()
    return
  }
  syncUrl()
}

function endSession() {
  base = null
  baseName = null
  prevAnchorWorld = null
  state.active = false
  state.kind = null
  state.reroll = false
  state.level = 0
  state.seed = null
  syncUrl()
}

async function rebase(structure, name) {
  if (!state.active || name !== baseName) return false
  base = structure
  if (state.level === 0) await buildApi.build(structure, false)
  else await regenerate()
  return true
}

export function useSession() {
  return {
    state: readonly(state),
    startSession, endSession, rebase, probeDepth,
    next, all, undo, reset, reloadAll, fullReload, generate
  }
}
