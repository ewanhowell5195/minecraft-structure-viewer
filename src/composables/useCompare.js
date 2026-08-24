import { reactive, readonly, watch } from "vue"
import { useBuild } from "./useBuild.js"
import { useScene } from "./useScene.js"
import { usePacks } from "./usePacks.js"
import { useSlicers } from "./useSlicers.js"
import { useStructures } from "./useStructures.js"
import { useComparePacks } from "./useComparePacks.js"
import { useLock } from "./useLock.js"
import { setOverlay } from "./useHighlight.js"
import { readStructure } from "../nbt.js"
import { setParams } from "../params.js"
import { leafName as leaf } from "../transforms.js"
import { readStructureFile, structureName } from "../formats.js"
import { cellContents } from "../structdiff.js"

const build = useBuild()
const scene = useScene()
const packs = usePacks()
const slicers = useSlicers()
const structures = useStructures()
const comparePacks = useComparePacks()
const { locked } = useLock()

// mode "structs" is the right-click structure-vs-structure split, "versions"
// the panel's version-vs-version one; they share all the machinery
const state = reactive({
  on: false,
  mode: "",
  view: "slide",
  split: 0.5,
  left: "",
  right: "",
  leftInfo: null,
  show: { added: false, changed: false, removed: false },
  counts: { added: 0, changed: 0, removed: 0 },
  files: { main: "", panel: "" }
})

const HL = { added: "new", changed: "changed", removed: "removed" }
{
  const on = new Set((new URLSearchParams(location.search).get("hl") ?? "").split(",").filter(Boolean))
  for (const kind of Object.keys(HL)) state.show[kind] = on.has(HL[kind])
}

function syncHlUrl() {
  const on = Object.keys(HL).filter(kind => state.show[kind]).map(kind => HL[kind])
  setParams({ hl: on.length ? on.join(",") : null })
}

let stash = null
let leftGrid = null
let leftRel = "", rightRel = ""
let entering = false
// the structure on screen came from the comparison version alone
let onlyRel = ""
// with one side missing, the same file renders on both, comparing just the assets
const files = { main: null, panel: null }

const writeUrl = (left, right) => setParams({ structure: left || null, compare: right || null })

const quiet = () => !build.state.building && !comparePacks.state.busy && !locked.value

function settled() {
  if (quiet()) return Promise.resolve()
  return new Promise(resolve => {
    const stop = watch([() => build.state.building, () => comparePacks.state.busy, locked], () => {
      if (!quiet()) return
      stop()
      resolve()
    })
  })
}

// each load clears the slicers and comparing is two loads, so the cut is carried across
const AXES = ["x", "y", "z"]
const snapCut = () => AXES.map(a => ({ ...slicers.state[a] }))

function applyCut(cut) {
  if (!cut.some(s => s.on)) return
  AXES.forEach((a, i) => Object.assign(slicers.state[a], cut[i]))
}

function boxOf(group, structure) {
  const p = group.position, s = structure.size
  const min = [p.x - 8, p.y - 8, p.z - 8]
  return { min, max: min.map((v, i) => v + s[i] * 16) }
}

const STYLES = {
  added: { colour: "rgba(63, 195, 95, 0.28)", line: { colour: "#6fd487", alpha: 0.95 } },
  changed: { colour: "rgba(232, 184, 64, 0.28)", line: { colour: "#f0c85a", alpha: 0.95 } },
  removed: { colour: "rgba(255, 64, 89, 0.28)", line: { colour: "#ff6b82", alpha: 0.95 } }
}

let diffCells = { added: [], changed: [], removed: [] }

function computeDiff() {
  diffCells = { added: [], changed: [], removed: [] }
  const right = build.current.value
  if (!stash?.structure || !right) return
  const before = cellContents(stash.structure), after = cellContents(right)
  for (const [k, v] of after) {
    if (!before.has(k)) diffCells.added.push(k.split(",").map(Number))
    else if (before.get(k) !== v) diffCells.changed.push(k.split(",").map(Number))
  }
  for (const k of before.keys()) if (!after.has(k)) diffCells.removed.push(k.split(",").map(Number))
  for (const kind of Object.keys(diffCells)) state.counts[kind] = diffCells[kind].length
}

function drawDiff() {
  if (!state.on) return setOverlay("compare", [])
  const groups = []
  for (const kind of ["removed", "changed", "added"]) {
    if (!state.show[kind] || !diffCells[kind].length) continue
    groups.push({ cells: diffCells[kind], ...STYLES[kind], merge: true, front: true })
  }
  setOverlay("compare", groups)
}

// both builds move onto a shared origin so the halves sit on one block grid
// and a diff cell means the same spot on either side
function basePos(obj) {
  obj.userData.compareBase ??= obj.position.clone()
  return obj.userData.compareBase
}

const AXES3 = ["x", "y", "z"]

function align() {
  if (!state.on) return
  const root = build.getRoot()
  const structure = build.current.value
  if (!root || !structure || !stash) return
  const left = basePos(stash.group), right = basePos(root)
  const origin = { x: 0, y: 0, z: 0 }
  for (const a of AXES3) origin[a] = Math.min(left[a], right[a])
  stash.group.position.set(origin.x, origin.y, origin.z)
  root.position.set(origin.x, origin.y, origin.z)
  if (leftGrid) leftGrid.group.position.set(origin.x - left.x, origin.y - left.y, origin.z - left.z)
  scene.setGridOffset(origin.x - right.x, origin.y - right.y, origin.z - right.z)
  const a = boxOf(stash.group, stash.structure), b = boxOf(root, structure)
  const min = a.min.map((v, i) => Math.min(v, b.min[i]))
  const max = a.max.map((v, i) => Math.max(v, b.max[i]))
  slicers.setSpan(min, min.map((v, i) => Math.max(1, Math.round((max[i] - v) / 16))), [stash.group, root])
}

function wireSplit(mode, leftLabel, rightLabel) {
  state.mode = mode
  state.left = leftLabel
  state.right = rightLabel
  state.leftInfo = stash.info
  state.split = 0.5
  state.on = true
  scene.contentRoots.add(stash.group)
  scene.animators.add(stash.animator)
  scene.setCompare({
    left: () => stash?.group ?? null,
    right: () => build.getRoot(),
    leftGrid: () => leftGrid?.group ?? null,
    split: () => state.split,
    view: () => state.view
  })
  align()
  computeDiff()
  drawDiff()
  scene.fit()
}

async function enter(rel) {
  if (state.on || entering || build.state.building) return
  const from = structures.state.selected[0]
  if (!from || !build.getRoot() || from === rel) return
  entering = true
  try {
    const { useStructure } = await import("./useStructure.js")
    const grid = scene.takeGrid()
    dropOverride()
    const cut = snapCut()
    slicers.setPreviewOnly(true)
    build.stashNextBuild()
    await useStructure().loadVanilla(rel)
    applyCut(cut)
    stash = build.takeStash()
    if (!stash || !build.getRoot()) {
      build.disposeStash(stash)
      scene.disposeGrid(grid?.group)
      stash = null
      return
    }
    leftGrid = grid
    leftRel = from
    rightRel = rel
    structures.stateMut.selected = [from, rel]
    writeUrl(from, rel)
    wireSplit("structs", leaf(from), leaf(rel))
  } finally {
    entering = false
  }
}

async function buildRightSplit(rightStruct, leftLabel, rightLabel) {
  const grid = scene.takeGrid()
  slicers.setPreviewOnly(true)
  build.stashNextBuild()
  build.setAssetsOverride(comparePacks.assets.value)
  const ok = await build.build(rightStruct, false, false, true)
  stash = build.takeStash()
  if (ok !== true || !stash || !build.getRoot()) {
    build.setAssetsOverride(null)
    build.disposeStash(stash)
    scene.disposeGrid(grid?.group)
    stash = null
    return false
  }
  leftGrid = grid
  wireSplit("versions", leftLabel, rightLabel)
  return true
}

async function enterVersion(rel) {
  if (entering || build.state.building || !comparePacks.state.armed) return
  entering = true
  try {
    setFile("main", null)
    setFile("panel", null)
    const cut = snapCut()
    exit()
    dropOverride()
    await settled()
    const { useStructure } = await import("./useStructure.js")
    await useStructure().loadVanilla(rel)
    if (!build.getRoot() || !comparePacks.has(rel)) return
    const bytes = await comparePacks.readStructureBytes(rel)
    if (!bytes) return
    const rightStruct = await useStructure().processVanilla(rel, await readStructure(bytes))
    if (await buildRightSplit(rightStruct, packs.state.baseId || "current", comparePacks.state.baseId)) {
      leftRel = rightRel = rel
      applyCut(cut)
    }
  } finally {
    entering = false
  }
}

// the override stays on afterwards, so a setting that rebuilds keeps these assets
async function enterOnly(rel) {
  if (entering || build.state.building || !comparePacks.state.armed) return
  entering = true
  try {
    setFile("main", null)
    setFile("panel", null)
    exit()
    await settled()
    const bytes = await comparePacks.readStructureBytes(rel)
    if (!bytes) return
    const structure = await readStructure(bytes)
    const { useStructure } = await import("./useStructure.js")
    build.setAssetsOverride(comparePacks.assets.value)
    onlyRel = rel
    await useStructure().loadObject(structure, rel)
    if (build.current.value !== structure) return dropOverride()
    structures.stateMut.selected = [rel]
    writeUrl(rel, null)
  } finally {
    entering = false
  }
}

const pairable = rel => comparePacks.has(rel) && !!structures.zipPathOf(rel)

function openVersion(rel) {
  if (!comparePacks.state.armed) return
  if (pairable(rel)) return enterVersion(rel)
  return comparePacks.has(rel) ? enterOnly(rel) : loadMainOnly(rel)
}

async function loadMainOnly(rel) {
  const { useStructure } = await import("./useStructure.js")
  return useStructure().loadVanilla(rel)
}

async function enterFiles() {
  if (entering || !comparePacks.state.armed) return
  const leftFile = files.main ?? files.panel
  const rightFile = files.panel ?? files.main
  if (!leftFile) return
  entering = true
  try {
    const cut = snapCut()
    exit()
    dropOverride()
    await settled()
    const { useStructure } = await import("./useStructure.js")
    await useStructure().loadFile(leftFile, !!files.main)
    if (!build.getRoot()) return
    const rightStruct = await readStructureFile(rightFile)
    const both = files.main && files.panel && files.main.name !== files.panel.name
    const leftLabel = both ? `${packs.state.baseId} · ${structureName(leftFile.name)}` : packs.state.baseId || "current"
    const rightLabel = both ? `${comparePacks.state.baseId} · ${structureName(rightFile.name)}` : comparePacks.state.baseId
    if (await buildRightSplit(rightStruct, leftLabel, rightLabel)) {
      leftRel = rightRel = ""
      applyCut(cut)
    }
  } finally {
    entering = false
  }
}

function setFile(side, file) {
  files[side] = file
  state.files[side] = file?.name ?? ""
}

const setMainFile = file => {
  setFile("main", file)
  return enterFiles()
}

const setPanelFile = file => {
  setFile("panel", file)
  return enterFiles()
}

const fileName = side => state.files[side]

async function clearFile(side) {
  if (!files[side]) return
  setFile(side, null)
  if (files.main || files.panel) return enterFiles()
  exit()
  const sel = structures.state.selected
  if (comparePacks.state.armed && sel.length === 1 && pairable(sel[0])) return enterVersion(sel[0])
  const { useStructure } = await import("./useStructure.js")
  await useStructure().loadDefault()
  await tryAutoEnter()
}

// every load funnels through exit, so it also releases the override, except
// when this module's own load is the one holding it
function dropOverride() {
  build.setAssetsOverride(null)
  onlyRel = ""
}

function exit() {
  if (!entering) dropOverride()
  if (!state.on) return
  const wasVersions = state.mode === "versions"
  setOverlay("compare", [])
  diffCells = { added: [], changed: [], removed: [] }
  state.counts.added = state.counts.changed = state.counts.removed = 0
  scene.setCompare(null)
  slicers.setPreviewOnly(false)
  build.disposeStash(stash)
  scene.disposeGrid(leftGrid?.group)
  scene.setGridOffset(0)
  stash = null
  leftGrid = null
  state.on = false
  state.mode = ""
  state.left = ""
  state.right = ""
  state.leftInfo = null
  if (!wasVersions) {
    structures.stateMut.selected = rightRel ? [rightRel] : []
    writeUrl(rightRel, null)
  }
  leftRel = ""
  rightRel = ""
  const root = build.getRoot(), structure = build.current.value
  // the surviving build goes back to its own centring, with its grid
  if (root?.userData.compareBase) root.position.copy(root.userData.compareBase)
  if (root && structure) slicers.setSpan(boxOf(root, structure).min, structure.size, [root])
}

// while the live build holds the comparison stack's assets, the main view is
// rebuilt first so the cache isn't freed under live meshes
async function stop() {
  setFile("main", null)
  setFile("panel", null)
  const rebuild = comparePacks.state.armed && (state.mode === "versions" || !!onlyRel)
  exit()
  if (rebuild) {
    const { useStructure } = await import("./useStructure.js")
    await useStructure().apply(false)
  }
  if (comparePacks.state.armed) await comparePacks.deactivate()
}

const worldOpened = () => stop()

// a setting that rebuilds only touches the live half, so both are rebuilt
async function refresh() {
  if (!state.on || entering) return
  const at = state.split
  const { useStructure } = await import("./useStructure.js")
  useStructure().setQuietLoads(true)
  try {
    if (state.mode === "versions") {
      if (files.main || files.panel) await enterFiles()
      else if (rightRel) await enterVersion(rightRel)
    } else {
      const a = leftRel, b = rightRel, cut = snapCut()
      exit()
      await settled()
      await useStructure().loadVanilla(a)
      applyCut(cut)
      await enter(b)
    }
  } finally {
    useStructure().setQuietLoads(false)
  }
  if (state.on) state.split = at
}

function tryAutoEnter() {
  if (entering || !comparePacks.state.armed) return
  if (state.on) {
    if (state.mode !== "structs") return
    exit()
  }
  if (files.main || files.panel) return enterFiles()
  const sel = structures.state.selected
  if (sel.length === 1 && pairable(sel[0])) return enterVersion(sel[0])
}

watch(() => [build.state.lighting, build.state.fullbright, build.state.hideStructureBlocks], refresh)
watch(() => packs.state.assetsVersion, () => {
  if (!state.on) return
  state.mode === "versions" ? refresh() : exit()
})
watch(() => comparePacks.state.assetsVersion, async () => {
  if (!comparePacks.state.armed) return
  await settled()
  if (!comparePacks.state.armed) return
  if (state.on && state.mode === "versions") refresh()
  else if (onlyRel) enterOnly(onlyRel)
  else tryAutoEnter()
})
watch(() => build.state.info, () => {
  align()
  if (state.on) drawDiff()
})
watch(() => ({ ...state.show }), () => {
  drawDiff()
  syncHlUrl()
}, { deep: true })

import("./useWorld.js").then(({ useWorld }) => {
  watch(() => useWorld().state.active, on => { if (on) worldOpened() })
})

const versionArmed = () => comparePacks.state.armed

export function useCompare() {
  return { state: readonly(state), stateMut: state, enter, enterVersion, openVersion, setMainFile, setPanelFile, clearFile, fileName, exit, stop, versionArmed }
}
