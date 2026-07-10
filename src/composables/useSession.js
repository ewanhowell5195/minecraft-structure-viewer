import { reactive, readonly } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useStructures } from "./useStructures.js"
import { useBuild } from "./useBuild.js"
import { useScene } from "./useScene.js"
import { useLock } from "./useLock.js"
import { readStructure } from "../nbt.js"
import { AIR, EMPTY, JIGSAW, mix, parseState, poolTemplates } from "../transforms.js"
import { runJigsaw } from "../jigsaw.js"
import { runDesertPyramid, runDesertWell, runDungeon, runEndCity, runEndSpikes, runFortress, runIgloo, runJungleTemple, runMansion } from "../generators/index.js"
import { PROC } from "../proc.js"

// A level session exists for jigsaw structures (any palette block named
// jigsaw) and steppable procedurals loaded ON their entry piece; the mansion
// (steps: false) gets a one-shot generate button instead. Internal level is
// 0-based, the UI shows level + 1 ("level 1" = the raw base).
//
// Seed semantics: the base is seedless and always identical. A seed is picked
// when you FIRST advance off the base (each fresh ascent re-rolls); past the
// base it is fixed, so stepping up/down is stable. Jigsaw levels derive
// per-level rngs via mix(seed, level); a procedural runs its single stream
// from the seed and filters by depth.

const packs = usePacks()
const structures = useStructures()
const buildApi = useBuild()
const sceneApi = useScene()
const { lock, locked } = useLock()

const state = reactive({
  active: false,
  kind: null,     // "jigsaw" | a PROC gen name
  label: "Structure Blocks",
  steps: true,
  level: 0,
  maxDepth: 7,
  seed: null,
  solving: false
})

let base = null, baseName = null
let baseRadius = 96
let prevAnchorWorld = null

// ?seed/?level are adopted by the FIRST session only (the initial ?vanilla
// load); captured up front because loads rewrite the query string
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

const rand32 = () => (Math.random() * 0x100000000) >>> 0
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

// PROC gen name -> (loadStruct, { maxDepth, seed }) => { structure, maxDepth }
const generators = {
  igloo: runIgloo, end_city: runEndCity, mansion: runMansion,
  jungle_temple: runJungleTemple, desert_pyramid: runDesertPyramid, desert_well: runDesertWell, dungeon: runDungeon,
  fortress: runFortress, end_spikes: runEndSpikes
}

async function resolve(level) {
  if (level === 0 || !base) return { structure: base }
  if (state.kind === "jigsaw") {
    // radius bounds like the game (max_distance_from_center); the piece cap
    // is only a runaway backstop, vanilla has none
    return runJigsaw(base, {
      loadStruct, loadPool,
      maxDepth: level, maxPieces: 1024, maxRadius: baseRadius,
      levelSeed: l => mix(state.seed, l),
      onProgress: n => { buildApi.state.status = `loading… ${n} pieces` },
      // at the declared depth cap no further level will ever run, so the
      // frontier's jigsaws are consumed like vanilla's finished generation
      keepJigsaws: level < state.maxDepth
    })
  }
  const gen = generators[state.kind]
  if (!gen) return { structure: base }
  return gen(loadStruct, { maxDepth: level, seed: state.seed })
}

// rebuild the resolved structure, keeping the camera relatively positioned to
// the start piece: the assembly re-centres each build, so the camera shifts
// by however far the base's anchor moved in world space
async function regenerate() {
  state.solving = true
  try {
    let structure
    try {
      const res = await resolve(state.level)
      structure = res.structure
      // a solve that stopped short of the requested level IS at max depth:
      // a dry graph (the outpost's declared size is 7 but its features stop
      // at depth 2) or the piece cap (rounds replay identically, so deeper
      // levels re-solve to the same pieces) would make every further level
      // a no-op that only consumes the hidden frontier jigsaws. the floor is
      // 1, not the deepest piece: even a round that placed nothing consumed
      // the base's jigsaws, so it's still a step above the raw base
      if (state.kind === "jigsaw" && (res.exhausted || res.capped || res.depth < state.level)) {
        state.maxDepth = Math.max(res.depth, 1)
        if (state.level > state.maxDepth) state.level = state.maxDepth
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
    u.searchParams.set("seed", state.seed.toString(16))
    u.searchParams.set("level", String(state.level + 1))
  } else {
    u.searchParams.delete("seed")
    u.searchParams.delete("level")
  }
  history.replaceState(null, "", u)
}

// target Infinity means "the full depth", resolved AFTER any re-probe
async function setLevel(target, { freshSeed = false } = {}) {
  if (target > 0 && (freshSeed || state.seed == null)) {
    state.seed = rand32()
    // a procedural's true depth depends on the seed; a jigsaw's comes from
    // the worldgen size (re-read in case packs changed); the one-shot mansion
    // has nothing to probe
    if (state.kind === "jigsaw") {
      state.maxDepth = structures.getStructDepth(baseName) ?? state.maxDepth
      baseRadius = structures.getStructRadius(baseName) ?? baseRadius
    }
    else if (state.steps) await probeDepth()
  }
  target = Math.max(0, Math.min(target, state.maxDepth))
  if (target === 0) state.seed = null // next ascent from the base re-rolls
  state.level = target
  await regenerate()
}

// menu ops; each locks for the whole solve + build
const op = fn => async (...args) => {
  if (locked.value || !state.active) return
  lock(true)
  try { await fn(...args) } finally { lock(false) }
}
const next = op(() => setLevel(state.level + 1))
const all = op(() => setLevel(Infinity))
const undo = op(() => setLevel(state.level - 1))
const reset = op(() => setLevel(0))
const reloadAll = op(() => setLevel(state.level, { freshSeed: true }))     // jigsaw only
const fullReload = op(() => setLevel(Infinity, { freshSeed: true }))
const generate = fullReload // one-shot for non-stepped procedurals (mansion)

// probe a procedural's true depth for this seed by running it unbounded, so
// "next" disables at the real end (an igloo always has its basement, end city
// depth varies by seed)
async function probeDepth() {
  const gen = generators[state.kind]
  if (!gen || state.seed == null) return
  const { maxDepth } = await gen(loadStruct, { maxDepth: Infinity, seed: state.seed })
  if (typeof maxDepth === "number") state.maxDepth = maxDepth
}

// whether any jigsaw could change the structure: a pool chain with a real
// template to place, or a visible final_state to swap in. pieces where every
// jigsaw fails both (the village animal spawners: empty pool, structure_void
// final_state) have no real levels, so they get no session
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

// called by useStructure after a NEW structure builds. adopts ?seed/?level
// once, on the initial page-load structure
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
    state.maxDepth = proc.maxDepth ?? 1
  } else if (isJigsaw && await jigsawsCanAct(structure)) {
    state.kind = "jigsaw"
    state.label = "Structure Blocks"
    state.steps = true
    await structures.computeWorldgen()
    // pieces with no structure def (mid-generation pieces, unmapped modded
    // ones) get generous caps: the stop-short clamp shrinks them to the
    // real depth as soon as a solve runs dry. 128 is the codec max radius
    state.maxDepth = structures.getStructDepth(name) ?? 20
    baseRadius = structures.getStructRadius(name) ?? 128
  } else {
    endSession()
    return
  }
  state.level = 0
  state.seed = null
  state.active = true
  const root = buildApi.getRoot()
  if (root) prevAnchorWorld = root.position.clone()

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
  state.level = 0
  state.seed = null
  syncUrl()
}

// pack swap re-read: keep the session, swap the base, regenerate in place
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
