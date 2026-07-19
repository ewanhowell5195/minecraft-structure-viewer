import { reactive, shallowRef, readonly } from "vue"
import { loadLibrary } from "../lib.js"
import { loadMojangJar } from "../mojang.js"
import { cachePack, uncachePack, setPackOrder, restorePacks } from "../userCache.js"
import { proxyFetch, remoteName } from "../remote.js"
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
  assetsVersion: 0,
  remoteStatus: "",
  remoteError: ""
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

async function loadBase(swap, ready) {
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
    await ready
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
      cachePack(file)
    }
    state.packs.unshift(...added)
    setPackOrder(state.packs.map(p => p.name))
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
    const [removed] = state.packs.splice(i, 1)
    bytesById.delete(id)
    uncachePack(removed.name)
    setPackOrder(state.packs.map(p => p.name))
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
    setPackOrder(state.packs.map(p => p.name))
    await rebuildAssets(swap)
  } finally {
    state.busy = false
    lock(false)
  }
}

// packs= URL packs: all fetched concurrently (and concurrently with the jar;
// loadBase's ready gate holds the rebuild until they land), added at the front
// so the list order is the priority order, never written to the pack cache
async function addUrlPacks(urls) {
  const mb = n => (n / 1048576).toFixed(0)
  const prog = urls.map(() => ({ got: 0, total: 0 }))
  const label = urls.length === 1 ? remoteName(urls[0]) : `${urls.length} packs`
  const update = () => {
    let got = 0, total = 0
    for (const p of prog) {
      got += p.got
      total += p.total
    }
    state.remoteStatus = total
      ? `downloading ${label}… ${mb(Math.min(got, total))}/${mb(total)}MB`
      : `downloading ${label}… ${mb(got)}MB`
  }
  update()
  const results = await Promise.all(urls.map(async (url, i) => {
    const name = remoteName(url)
    try {
      const bytes = await proxyFetch(url, (got, total) => {
        prog[i].got = got
        prog[i].total = total
        update()
      })
      return { name, bytes }
    } catch (err) {
      console.warn(`couldn't fetch pack ${url}:`, err)
      state.remoteError = `couldn't fetch pack: ${name}`
      return null
    }
  }))
  const added = []
  for (const r of results) {
    if (!r) continue
    const id = nextId++
    bytesById.set(id, r.bytes)
    added.push({ id, name: r.name })
  }
  state.packs.unshift(...added)
  state.remoteStatus = ""
}

async function restoreCachedPacks() {
  for (const file of await restorePacks()) {
    const id = nextId++
    bytesById.set(id, new Uint8Array(await file.arrayBuffer()))
    state.packs.push({ id, name: file.name })
  }
}

const allSources = () => state.packs.map(p => bytesById.get(p.id)).concat(baseBytes, builtinBytes, featureBytes).filter(Boolean)

// the vanilla jar is excluded on purpose: minecraft features list only from
// the bundle, so anything the tools removed stays gone on snapshot jars too
const featureSources = () => state.packs.map(p => bytesById.get(p.id)).concat(builtinBytes, featureBytes).filter(Boolean)

export function usePacks() {
  return { state: readonly(state), assets, loadBase, setChannel, addPacks, addUrlPacks, removePack, movePack, restoreCachedPacks, allSources, featureSources, setSwapHandler }
}
