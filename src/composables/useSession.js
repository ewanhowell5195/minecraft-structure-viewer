import { reactive, readonly } from "vue"
import * as THREE from "three"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useStructures } from "./useStructures.js"
import { useBuild } from "./useBuild.js"
import { useScene } from "./useScene.js"
import { useLock } from "./useLock.js"
import { readStructure } from "../nbt.js"
import { JIGSAW, mix } from "../transforms.js"
import { runJigsaw } from "../jigsaw.js"
import { runEndCity, runIgloo, runMansion } from "../generators/index.js"
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
  label: "structure blocks",
  steps: true,
  level: 0,
  maxDepth: 7,
  seed: null,
  solving: false
})

let base = null, baseName = null
let prevAnchorWorld = null
let urlAdopted = false

const rand32 = () => (Math.random() * 0x100000000) >>> 0
const nsSplit = ref => {
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
const generators = { igloo: runIgloo, end_city: runEndCity, mansion: runMansion }

async function resolve(level) {
  if (level === 0 || !base) return { structure: base }
  if (state.kind === "jigsaw") {
    return runJigsaw(base, {
      loadStruct, loadPool,
      maxDepth: level, maxPieces: 128, maxRadius: 96,
      levelSeed: l => mix(state.seed, l),
      onProgress: n => { buildApi.state.status = `loading… ${n} pieces` }
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
      structure = (await resolve(state.level)).structure
    } catch (err) {
      buildApi.state.status = `couldn't assemble: ${err}`
      return
    }
    await buildApi.build(structure, false, true)
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
    if (state.kind === "jigsaw") state.maxDepth = structures.getStructDepth(baseName) ?? state.maxDepth
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
  } else if (isJigsaw) {
    state.kind = "jigsaw"
    state.label = "structure blocks"
    state.steps = true
    await structures.computeWorldgen()
    state.maxDepth = structures.getStructDepth(name) ?? 7
  } else {
    endSession()
    return
  }
  state.level = 0
  state.seed = null
  state.active = true
  const root = buildApi.getRoot()
  if (root) prevAnchorWorld = root.position.clone()

  if (!urlAdopted) {
    urlAdopted = true
    const sp = new URLSearchParams(location.search)
    const seedHex = sp.get("seed")
    if (seedHex && /^[0-9a-f]{1,8}$/i.test(seedHex)) {
      state.seed = parseInt(seedHex, 16) >>> 0
      if (state.steps) {
        const lvl = parseInt(sp.get("level"))
        state.level = Math.max(1, Math.min((Number.isFinite(lvl) ? lvl : 2) - 1, state.maxDepth))
      } else state.level = state.maxDepth
      await regenerate()
      return
    }
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
  if (state.level === 0) await buildApi.build(structure, false, true)
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
