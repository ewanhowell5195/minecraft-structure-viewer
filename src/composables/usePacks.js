import { reactive, shallowRef, readonly } from "vue"
import { loadLibrary } from "../lib.js"
import { loadMojangJar } from "../mojang.js"
import { cachePack, uncachePack, setPackOrder, restorePacks } from "../userCache.js"
import { proxyFetch, remoteName } from "../remote.js"
import { warmIcons } from "../icons.js"
import { setParams } from "../params.js"
import { mb } from "../format.js"
import { useLock } from "./useLock.js"

// index 0 = highest priority (prepareAssets first-wins order); pack bytes
// stay outside the reactive state so large buffers aren't proxied
const bytesById = new Map()
let baseVirtual = false
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
  baseType: "",
  baseStatus: "loading…",
  baseProgress: 0,
  baseFailed: false,
  packs: [],
  busy: false,
  assetsVersion: 0,
  remoteStatus: "",
  remoteError: ""
})

if (state.version && new URLSearchParams(location.search).has("channel")) setParams({ channel: null })

const assets = shallowRef(null)
const { locked, withBusy } = useLock()

let swapHandler = null
const setSwapHandler = fn => { swapHandler = fn }

// set by the embed API, which owns the channel a virtual source reads over
let makeHandler = () => { throw new Error("virtual sources need the embed API") }
const setHandlerFactory = fn => { makeHandler = fn }

// picking a channel unpins
const setChannelParam = ch => setParams({ channel: ch === "snapshot" ? "snapshot" : null, version: null })

// dispose the previous bundle only after `swap` resolves, so the on-screen
// scene keeps its cached textures until the rebuild lands
async function rebuildAssets(swap) {
  const lib = await loadLibrary()
  let sources = state.packs.map(p => bytesById.get(p.id)).concat(baseBytes).filter(Boolean)
  if (sources.length) sources = sources.concat(builtinBytes ?? [], featureBytes ?? [])
  const prev = assets.value
  assets.value = sources.length ? await lib.prepareAssets(sources, { cache: true, defaults: "game" }) : null
  state.assetsVersion++
  try {
    await (swap ?? swapHandler)?.(assets.value)
  } finally {
    if (prev && prev !== assets.value) lib.disposeCache(prev)
  }
  if (assets.value) warmIcons()
}

const loadBase = (swap, ready) => withBusy(state, async () => {
  state.baseFailed = false
  state.baseStatus = "loading…"
  state.baseProgress = 0
  try {
    await loadBuiltin()
    const r = await loadMojangJar(state.channel, (got, total, ver) => {
      state.baseStatus = `downloading ${ver}… ${mb(got)}/${mb(total)}MB`
      state.baseProgress = total ? got / total : 0
    }, state.version)
    baseBytes = r.bytes
    state.baseId = r.id
    state.baseType = r.type
    state.baseStatus = ""
  } catch (err) {
    console.warn("couldn't load the vanilla jar:", err)
    baseBytes = null
    state.baseId = ""
    state.baseStatus = /^version not found/.test(err?.message) ? err.message : "vanilla download failed"
    state.baseFailed = true
  }
  state.baseProgress = 0
  await ready
  await rebuildAssets(swap)
})

// the embed API's stack: no vanilla download, no pack cache writes, and one
// rebuild however much the parent changes at once
const initSources = (ready, swap) => withBusy(state, async () => {
  state.baseStatus = ""
  await loadBuiltin()
  await ready
  await rebuildAssets(swap)
})

async function applyBase(base) {
  baseVirtual = false
  if (base === null) {
    baseBytes = null
    state.baseId = ""
    state.baseStatus = ""
    return
  }
  if (base?.handler) {
    baseBytes = makeHandler(base.handler)
    baseVirtual = true
    state.baseId = ""
    state.baseStatus = ""
    return
  }
  if (typeof base === "string") {
    state.baseFailed = false
    try {
      const r = await loadMojangJar(state.channel, (got, total, ver) => {
        state.baseStatus = `downloading ${ver}… ${mb(got)}/${mb(total)}MB`
      }, base)
      baseBytes = r.bytes
      state.baseId = r.id
      state.baseType = r.type
      state.baseStatus = ""
    } catch (err) {
      baseBytes = null
      state.baseId = ""
      state.baseStatus = ""
      state.baseFailed = true
      throw err
    }
    return
  }
  baseBytes = await toBytes(base)
  state.baseId = ""
  state.baseStatus = ""
}

async function toBytes(source) {
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (typeof source === "string") return proxyFetch(source)
  if (source?.arrayBuffer) return new Uint8Array(await source.arrayBuffer())
  throw new Error("unsupported pack source")
}

async function setPacks(packs) {
  const resolved = await Promise.all(packs.map(async entry => {
    if (entry?.handler) {
      return { name: entry.name ?? entry.handler, source: makeHandler(entry.handler), virtual: true }
    }
    const source = entry?.data ?? entry
    const name = entry?.name ?? (typeof source === "string" ? remoteName(source) : "pack")
    return { name, source: await toBytes(source) }
  }))
  for (const pack of state.packs) bytesById.delete(pack.id)
  state.packs = resolved.map(({ name, source, virtual }) => {
    const id = nextId++
    bytesById.set(id, source)
    return virtual ? { id, name, virtual } : { id, name }
  })
}

const loadPacks = ({ base, packs } = {}, swap) => withBusy(state, async () => {
  await loadBuiltin()
  if (base !== undefined) await applyBase(base)
  if (packs !== undefined) await setPacks(packs)
  await rebuildAssets(swap)
})

async function setVersion(id, swap) {
  if (state.busy || locked.value || id === state.version) return
  state.version = id
  setParams(id ? { version: id, channel: null } : { version: null })
  await loadBase(swap)
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
  await withBusy(state, async () => {
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
  })
}

async function removePack(id, swap) {
  if (state.busy || locked.value) return
  const i = state.packs.findIndex(p => p.id === id)
  if (i < 0) return
  await withBusy(state, async () => {
    const [removed] = state.packs.splice(i, 1)
    bytesById.delete(id)
    uncachePack(removed.name)
    setPackOrder(state.packs.map(p => p.name))
    await rebuildAssets(swap)
  })
}

async function movePack(id, delta, swap) {
  if (state.busy || locked.value) return
  const i = state.packs.findIndex(p => p.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= state.packs.length) return
  await withBusy(state, async () => {
    const [p] = state.packs.splice(i, 1)
    state.packs.splice(j, 0, p)
    setPackOrder(state.packs.map(p => p.name))
    await rebuildAssets(swap)
  })
}

// packs= URL packs: all fetched concurrently (and concurrently with the jar;
// loadBase's ready gate holds the rebuild until they land), added at the front
// so the list order is the priority order, never written to the pack cache
async function addUrlPacks(urls) {
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

const virtualSources = () => baseVirtual || state.packs.some(p => p.virtual)

// virtual sources carry assets only, and can't be read as a zip or handed to a
// worker; the callers that do either take these instead
const zipOnly = list => list.filter(s => s instanceof Uint8Array)
const zipSources = () => zipOnly(allSources())
const featureZipSources = () => zipOnly(featureSources())

const allSources = () => state.packs.map(p => bytesById.get(p.id)).concat(baseBytes, builtinBytes, featureBytes).filter(Boolean)

// the viewer's own two zips, which belong to no game version
const builtinSources = () => [builtinBytes, featureBytes].filter(Boolean)

// stable identity of the loaded source set, for keying persisted per-state
// caches; full content hashes, memoized per byte buffer
const fnvMemo = new WeakMap()
function fnvHash(bytes) {
  if (!bytes) return "0"
  let h = fnvMemo.get(bytes)
  if (h === undefined) {
    let v = 2166136261
    for (let i = 0; i < bytes.length; i++) { v ^= bytes[i]; v = Math.imul(v, 16777619) }
    h = (v >>> 0).toString(36) + "-" + bytes.length
    fnvMemo.set(bytes, h)
  }
  return h
}
// null means "don't persist": a virtual source has no bytes to hash, and a key
// that didn't track its contents would import masks computed from other models
const sourcesIdentity = () => virtualSources() ? null : [
  "v1",
  state.baseId || "nobase",
  ...state.packs.map(p => p.name + "~" + fnvHash(bytesById.get(p.id))),
  "b:" + fnvHash(builtinBytes),
  "f:" + fnvHash(featureBytes)
].join("|")

// the vanilla jar is excluded on purpose: minecraft features list only from
// the bundle, so anything the tools removed stays gone on snapshot jars too
const featureSources = () => state.packs.map(p => bytesById.get(p.id)).concat(builtinBytes, featureBytes).filter(Boolean)

export function usePacks() {
  return { state: readonly(state), assets, loadBase, initSources, loadPacks, setChannel, setVersion, addPacks, addUrlPacks, removePack, movePack, restoreCachedPacks, allSources, featureSources, builtinSources, zipSources, featureZipSources, virtualSources, sourcesIdentity, setSwapHandler, setHandlerFactory }
}
