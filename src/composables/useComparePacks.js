import { reactive, readonly, shallowRef } from "vue"
import { loadLibrary } from "../lib.js"
import { loadMojangJar } from "../mojang.js"
import { setParams } from "../params.js"
import { mb } from "../format.js"
import { useLock } from "./useLock.js"
import { STRUCT_RE } from "./useStructures.js"

// the comparison side's own stack: a second vanilla jar plus its own pack list,
// prepared independently of the main stack. picking a version arms comparison
// mode; nothing here touches the pack cache or the icon workers

const state = reactive({
  armed: false,
  channel: "release",
  version: "",
  baseId: "",
  baseType: "",
  baseStatus: "",
  baseProgress: 0,
  busy: false,
  packs: [],
  assetsVersion: 0
})

const assets = shallowRef(null)
const { locked, withBusy } = useLock()

const bytesById = new Map()
let baseBytes = null
let nextId = 1
let structPath = new Map()

// pinned versions write their id, a tracked channel writes the channel name, so
// a reload restores what was picked rather than freezing on today's snapshot
const setParam = id => setParams({ cversion: id })

const paramValue = () => state.version || state.channel

function fromParam(value) {
  if (!value || value === paramValue() && state.armed) return
  return value === "release" || value === "snapshot"
    ? activate({ channel: value })
    : activate({ version: value })
}

async function rebuild() {
  const lib = await loadLibrary()
  const sources = zipSources()
  const prev = assets.value
  assets.value = sources.length ? await lib.prepareAssets(sources, { cache: true, defaults: "game" }) : null
  structPath = new Map()
  for (const src of Array.from(sources).reverse()) {
    for (const k of lib.parseZip(src).keys()) {
      const m = k.match(STRUCT_RE)
      if (m) structPath.set(m[1] + "/" + m[2], k)
    }
  }
  state.assetsVersion++
  if (prev && prev !== assets.value) lib.disposeCache(prev)
}

async function loadBase() {
  state.baseStatus = "loading…"
  state.baseProgress = 0
  try {
    const r = await loadMojangJar(state.channel, (got, total, ver) => {
      state.baseStatus = `downloading ${ver}… ${mb(got)}/${mb(total)}MB`
      state.baseProgress = total ? got / total : 0
    }, state.version)
    baseBytes = r.bytes
    state.baseId = r.id
    state.baseType = r.type
    state.baseStatus = ""
    setParam(paramValue() || r.id)
  } catch (err) {
    console.warn("couldn't load the comparison jar:", err)
    baseBytes = null
    state.baseId = ""
    state.baseStatus = /^version not found/.test(err?.message) ? err.message : "vanilla download failed"
  }
  state.baseProgress = 0
  await rebuild()
}

// picking a channel or exact version is what turns comparison mode on
async function activate({ channel, version } = {}) {
  if (state.busy || locked.value) return
  state.channel = version ? "release" : channel ?? "release"
  state.version = version ?? ""
  state.armed = true
  await withBusy(state, loadBase)
}

async function deactivate() {
  if (!state.armed) return
  state.armed = false
  state.version = ""
  state.baseId = ""
  state.baseStatus = ""
  setParam(null)
  for (const p of state.packs) bytesById.delete(p.id)
  state.packs = []
  baseBytes = null
  structPath = new Map()
  const lib = await loadLibrary()
  if (assets.value) lib.disposeCache(assets.value)
  assets.value = null
  state.assetsVersion++
}

async function addPacks(files) {
  if (state.busy || locked.value || !files.length) return
  await withBusy(state, async () => {
    const added = []
    for (const file of files) {
      const id = nextId++
      bytesById.set(id, new Uint8Array(await file.arrayBuffer()))
      added.push({ id, name: file.name })
    }
    state.packs.unshift(...added)
    await rebuild()
  })
}

async function removePack(id) {
  if (state.busy || locked.value) return
  const i = state.packs.findIndex(p => p.id === id)
  if (i < 0) return
  await withBusy(state, async () => {
    state.packs.splice(i, 1)
    bytesById.delete(id)
    await rebuild()
  })
}

async function movePack(id, delta) {
  if (state.busy || locked.value) return
  const i = state.packs.findIndex(p => p.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= state.packs.length) return
  await withBusy(state, async () => {
    const [p] = state.packs.splice(i, 1)
    state.packs.splice(j, 0, p)
    await rebuild()
  })
}

const has = rel => structPath.has(rel)
const zipSources = () => state.packs.map(p => bytesById.get(p.id)).concat(baseBytes).filter(Boolean)

async function readStructureBytes(rel) {
  const zp = structPath.get(rel)
  if (!zp || !assets.value) return null
  const lib = await loadLibrary()
  return lib.readFile(zp, assets.value)
}

export function useComparePacks() {
  return { state: readonly(state), assets, activate, deactivate, fromParam, paramValue, addPacks, removePack, movePack, has, readStructureBytes, zipSources }
}
