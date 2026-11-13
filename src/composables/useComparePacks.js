import { reactive, readonly, shallowRef } from "vue"
import { loadLibrary } from "../lib.js"
import { loadMojangJar } from "../mojang.js"
import { releaseOf } from "../release.js"
import { proxyFetch, remoteName } from "../remote.js"
import { setParams } from "../params.js"
import { mb } from "../format.js"
import { useLock } from "./useLock.js"
import { STRUCT_RE } from "./useStructures.js"
import { onSession, sessionSignal } from "../session.js"


function defaults() {
  return { armed: false, channel: "release", version: "", baseId: "", baseType: "", baseStatus: "", baseProgress: 0, busy: false, packs: [] }
}

const state = reactive({
  armed: false,
  channel: "release",
  version: "",
  baseId: "",
  get baseRelease() { return releaseOf(this.baseId) },
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

// a pinned version writes its id, a tracked channel its name, so a reload
// restores the choice rather than freezing on today's snapshot
const setParam = id => setParams({ cversion: id })

const paramValue = () => state.version || state.channel

function fromParam(value) {
  if (!value || value === paramValue() && state.armed) return
  return value === "release" || value === "snapshot"
    ? activate({ channel: value })
    : activate({ version: value })
}

async function rebuild(signal) {
  const lib = await loadLibrary()
  if (signal.aborted) return
  const sources = allSources()
  const prev = assets.value
  const next = sources.length ? await lib.prepareAssets(sources, { cache: true, defaults: "game", ignoreAtlases: true, version: state.baseRelease || undefined }) : null
  if (signal.aborted) {
    if (next) lib.disposeCache(next)
    return
  }
  assets.value = next
  structPath = new Map()
  for (const src of Array.from(sources).reverse()) {
    if (!(src instanceof Uint8Array)) continue
    for (const k of lib.parseZip(src).keys()) {
      const m = k.match(STRUCT_RE)
      if (m) structPath.set(m[1] + "/" + m[2], k)
    }
  }
  state.assetsVersion++
  if (prev && prev !== assets.value) lib.disposeCache(prev)
}

async function loadBase() {
  const signal = sessionSignal()
  state.baseStatus = "loading…"
  state.baseProgress = 0
  try {
    const r = await loadMojangJar(state.channel, (got, total, ver) => {
      if (signal.aborted) return
      state.baseStatus = `downloading ${ver}… ${mb(got)}/${mb(total)}MB`
      state.baseProgress = total ? got / total : 0
    }, state.version)
    if (signal.aborted) return
    baseBytes = r.bytes
    state.baseId = r.id
    state.baseType = r.type
    state.baseStatus = ""
    setParam(paramValue() || r.id)
  } catch (err) {
    if (signal.aborted) return
    console.warn("couldn't load the comparison jar:", err)
    baseBytes = null
    state.baseId = ""
    state.baseStatus = /^version not found/.test(err?.message) ? err.message : "vanilla download failed"
  }
  state.baseProgress = 0
  await rebuild(signal)
}

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
  const signal = sessionSignal()
  await withBusy(state, async () => {
    const added = []
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (signal.aborted) return
      const id = nextId++
      bytesById.set(id, bytes)
      added.push({ id, name: file.name })
    }
    state.packs.unshift(...added)
    await rebuild(signal)
  })
}

async function removePack(id) {
  if (state.busy || locked.value) return
  const i = state.packs.findIndex(p => p.id === id)
  if (i < 0) return
  const signal = sessionSignal()
  await withBusy(state, async () => {
    state.packs.splice(i, 1)
    bytesById.delete(id)
    await rebuild(signal)
  })
}

async function movePack(id, delta) {
  if (state.busy || locked.value) return
  const i = state.packs.findIndex(p => p.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= state.packs.length) return
  const signal = sessionSignal()
  await withBusy(state, async () => {
    const [p] = state.packs.splice(i, 1)
    state.packs.splice(j, 0, p)
    await rebuild(signal)
  })
}

// set by the embed API, which owns the channel a virtual source reads over
let makeHandler = () => { throw new Error("virtual sources need the embed API") }
const setHandlerFactory = fn => { makeHandler = fn }

async function toBytes(source, signal) {
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (typeof source === "string") return proxyFetch(source, undefined, signal)
  if (source?.arrayBuffer) return new Uint8Array(await source.arrayBuffer())
  throw new Error("unsupported pack source")
}

async function applyEmbedBase(base, signal) {
  state.version = ""
  state.baseType = ""
  if (base === null) {
    baseBytes = null
    state.baseId = ""
    return
  }
  if (base?.handler) {
    baseBytes = makeHandler(base.handler)
    state.baseId = base.name ?? base.handler
    return
  }
  if (typeof base === "string") {
    const channel = base === "release" || base === "snapshot" ? base : "release"
    const version = channel === base ? "" : base
    try {
      const r = await loadMojangJar(channel, (got, total, ver) => {
        if (signal.aborted) return
        state.baseStatus = `downloading ${ver}… ${mb(got)}/${mb(total)}MB`
        state.baseProgress = total ? got / total : 0
      }, version)
      if (signal.aborted) return
      baseBytes = r.bytes
      state.channel = channel
      state.version = version
      state.baseId = r.id
      state.baseType = r.type
    } finally {
      if (!signal.aborted) {
        state.baseStatus = ""
        state.baseProgress = 0
      }
    }
    return
  }
  const bytes = await toBytes(base?.data ?? base, signal)
  if (signal.aborted) return
  baseBytes = bytes
  state.baseId = base?.name ?? "custom"
}

async function setEmbedPacks(packs, signal) {
  const resolved = await Promise.all(packs.map(async entry => {
    if (entry?.handler) return { name: entry.name ?? entry.handler, source: makeHandler(entry.handler) }
    const source = entry?.data ?? entry
    const name = entry?.name ?? (typeof source === "string" ? remoteName(source) : "pack")
    return { name, source: await toBytes(source, signal) }
  }))
  if (signal.aborted) return
  for (const p of state.packs) bytesById.delete(p.id)
  state.packs = resolved.map(({ name, source }) => {
    const id = nextId++
    bytesById.set(id, source)
    return { id, name }
  })
}

// the embed API's stack: same source shapes as the main side's loadPacks, no
// URL params written, and clearing everything disarms
async function loadSources({ base, packs } = {}) {
  const signal = sessionSignal()
  await withBusy(state, async () => {
    if (base !== undefined) await applyEmbedBase(base, signal)
    if (packs !== undefined) await setEmbedPacks(packs, signal)
    if (signal.aborted) return
    if (allSources().length) {
      state.armed = true
      await rebuild(signal)
    } else if (state.armed) await deactivate()
  })
}

const has = rel => structPath.has(rel)
const names = () => Array.from(structPath.keys())
const allSources = () => state.packs.map(p => bytesById.get(p.id)).concat(baseBytes).filter(Boolean)
const zipSources = () => allSources().filter(s => s instanceof Uint8Array)

async function readStructureBytes(rel) {
  const zp = structPath.get(rel)
  if (!zp || !assets.value) return null
  const lib = await loadLibrary()
  return lib.readFile(assets.value, zp)
}

export function useComparePacks() {
  return { state: readonly(state), assets, activate, deactivate, fromParam, paramValue, addPacks, removePack, movePack, has, names, readStructureBytes, zipSources, loadSources, setHandlerFactory }
}

onSession(() => {
  Object.assign(state, defaults())
  nextId = 1
  return () => {
    const prev = assets.value
    assets.value = null
    baseBytes = null
    bytesById.clear()
    structPath = new Map()
    if (prev) loadLibrary().then(lib => lib.disposeCache(prev))
  }
})
