import { reactive, shallowRef, readonly } from "vue"
import { loadLibrary } from "../lib.js"
import { loadMojangJar } from "../mojang.js"
import { useLock } from "./useLock.js"

// index 0 = highest priority (prepareAssets first-wins order); pack bytes
// stay outside the reactive state so large buffers aren't proxied
const bytesById = new Map()
let baseBytes = null
let builtinBytes = null
let featureBytes = null
let nextId = 1

// the game's hardcoded structures (tools/builtin) and code-built features
// (tools/features); lowest priority, they only add entries vanilla doesn't ship
async function loadBuiltin() {
  if (!builtinBytes) {
    try {
      const res = await fetch(import.meta.env.BASE_URL + "builtin.zip")
      if (res.ok) builtinBytes = new Uint8Array(await res.arrayBuffer())
    } catch {}
  }
  if (!featureBytes) {
    try {
      const res = await fetch(import.meta.env.BASE_URL + "features.zip")
      if (res.ok) featureBytes = new Uint8Array(await res.arrayBuffer())
    } catch {}
  }
}

const state = reactive({
  channel: new URLSearchParams(location.search).get("channel") === "snapshot" ? "snapshot" : "release",
  version: new URLSearchParams(location.search).get("version") || "",
  baseId: "",
  baseStatus: "loading…",
  baseFailed: false,
  packs: [],
  busy: false,
  assetsVersion: 0
})

const assets = shallowRef(null)
const { lock, locked } = useLock()

let swapHandler = null
const setSwapHandler = fn => { swapHandler = fn }

function setChannelParam(ch) {
  const u = new URL(location)
  ch === "snapshot" ? u.searchParams.set("channel", "snapshot") : u.searchParams.delete("channel")
  u.searchParams.delete("version") // picking a channel unpins
  history.replaceState(null, "", u)
}

// dispose the previous bundle only after `swap` resolves, so the on-screen
// scene keeps its cached textures until the rebuild lands
async function rebuildAssets(swap) {
  const lib = await loadLibrary()
  let sources = state.packs.map(p => bytesById.get(p.id)).concat(baseBytes).filter(Boolean)
  if (sources.length) sources = sources.concat(builtinBytes ?? [], featureBytes ?? [])
  const prev = assets.value
  assets.value = sources.length ? await lib.prepareAssets(sources, { cache: true }) : null
  state.assetsVersion++
  try {
    await (swap ?? swapHandler)?.(assets.value)
  } finally {
    if (prev && prev !== assets.value) lib.disposeCache(prev)
  }
}

async function loadBase(swap) {
  state.busy = true
  lock(true)
  state.baseFailed = false
  try {
    await loadBuiltin()
    const mb = n => (n / 1048576).toFixed(0)
    const r = await loadMojangJar(state.channel, (got, total, ver) => {
      state.baseStatus = `downloading ${ver}… ${mb(got)}/${mb(total)}MB`
    }, state.version)
    baseBytes = r.bytes
    state.baseId = r.id
    state.baseStatus = ""
  } catch (err) {
    console.warn("couldn't load the vanilla jar:", err)
    baseBytes = null
    state.baseId = ""
    state.baseStatus = /^version not found/.test(err?.message) ? err.message : "vanilla download failed"
    state.baseFailed = true
  }
  try {
    await rebuildAssets(swap)
  } finally {
    state.busy = false
    lock(false)
  }
}

async function setChannel(channel, swap) {
  if (state.busy || locked.value || (channel === state.channel && !state.version)) return
  state.channel = channel
  state.version = ""
  setChannelParam(channel)
  await loadBase(swap)
}

async function addPacks(files, swap) {
  if (state.busy || locked.value || !files.length) return
  state.busy = true
  lock(true)
  try {
    const added = []
    for (const file of files) {
      const id = nextId++
      bytesById.set(id, new Uint8Array(await file.arrayBuffer()))
      added.push({ id, name: file.name })
    }
    state.packs.unshift(...added)
    await rebuildAssets(swap)
  } finally {
    state.busy = false
    lock(false)
  }
}

async function removePack(id, swap) {
  if (state.busy || locked.value) return
  const i = state.packs.findIndex(p => p.id === id)
  if (i < 0) return
  state.busy = true
  lock(true)
  try {
    state.packs.splice(i, 1)
    bytesById.delete(id)
    await rebuildAssets(swap)
  } finally {
    state.busy = false
    lock(false)
  }
}

async function movePack(id, delta, swap) {
  if (state.busy || locked.value) return
  const i = state.packs.findIndex(p => p.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= state.packs.length) return
  state.busy = true
  lock(true)
  try {
    const [p] = state.packs.splice(i, 1)
    state.packs.splice(j, 0, p)
    await rebuildAssets(swap)
  } finally {
    state.busy = false
    lock(false)
  }
}

const allSources = () => state.packs.map(p => bytesById.get(p.id)).concat(baseBytes, builtinBytes, featureBytes).filter(Boolean)

export function usePacks() {
  return { state: readonly(state), assets, loadBase, setChannel, addPacks, removePack, movePack, allSources, setSwapHandler }
}
