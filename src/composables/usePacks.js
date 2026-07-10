import { reactive, shallowRef, readonly } from "vue"
import { loadLibrary } from "../lib.js"
import { loadMojangJar } from "../mojang.js"
import { useLock } from "./useLock.js"

// Ordered pack overlay: user packs (index 0 = highest priority) over the
// vanilla base jar. Maps directly onto prepareAssets source order (first wins).
// Pack bytes live outside the reactive state (no proxying of large buffers).

const bytesById = new Map()
let baseBytes = null
let builtinBytes = null
let nextId = 1

// The game's hardcoded structures, extracted to .nbt by tools/builtin and
// bundled as a lowest-priority source (they only add data/.../structure/
// builtin/ entries, so packs and the vanilla jar always win a conflict)
async function loadBuiltin() {
  if (builtinBytes) return
  try {
    const res = await fetch(import.meta.env.BASE_URL + "builtin.zip")
    if (res.ok) builtinBytes = new Uint8Array(await res.arrayBuffer())
  } catch {}
}

const state = reactive({
  channel: new URLSearchParams(location.search).get("channel") === "snapshot" ? "snapshot" : "release",
  version: new URLSearchParams(location.search).get("version") || "", // exact id pin, beats the channel
  baseId: "",
  baseStatus: "loading…",
  baseFailed: false,
  packs: [],
  busy: false,
  assetsVersion: 0
})

const assets = shallowRef(null)
const { lock, locked } = useLock()

// default swap used when an action isn't given one explicitly: the app
// registers "rebuild the current scene with the new assets" here
let swapHandler = null
const setSwapHandler = fn => { swapHandler = fn }

function setChannelParam(ch) {
  const u = new URL(location)
  ch === "snapshot" ? u.searchParams.set("channel", "snapshot") : u.searchParams.delete("channel")
  u.searchParams.delete("version") // picking a channel unpins
  history.replaceState(null, "", u)
}

// Rebuild the asset bundle from the current pack list. The previous bundle is
// disposed only AFTER `swap` resolves: the caller rebuilds its scene inside
// `swap`, so nothing still on screen loses its cached textures mid-frame.
async function rebuildAssets(swap) {
  const lib = await loadLibrary()
  let sources = state.packs.map(p => bytesById.get(p.id)).concat(baseBytes).filter(Boolean)
  if (sources.length) sources = sources.concat(builtinBytes ?? [])
  const prev = assets.value
  assets.value = sources.length ? await lib.prepareAssets(sources, { cache: true }) : null
  state.assetsVersion++
  try {
    await (swap ?? swapHandler)?.(assets.value)
  } finally {
    if (prev && prev !== assets.value) lib.disposeCache(prev)
  }
}

// pack ops hold the global lock too: nothing else may start a load while the
// asset bundle is being replaced
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

// Every zip source currently contributing files, highest priority first.
// Structure discovery scans the union of these (a pack's data/ may add
// structures the base doesn't have).
const allSources = () => state.packs.map(p => bytesById.get(p.id)).concat(baseBytes, builtinBytes).filter(Boolean)

export function usePacks() {
  return { state: readonly(state), assets, loadBase, setChannel, addPacks, removePack, movePack, allSources, setSwapHandler }
}
