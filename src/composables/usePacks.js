import { reactive, shallowRef, readonly } from "vue"
import { loadLibrary } from "../lib.js"
import { loadMojangJar } from "../mojang.js"

// Ordered pack overlay: user packs (index 0 = highest priority) over the
// vanilla base jar. Maps directly onto prepareAssets source order (first wins).
// Pack bytes live outside the reactive state (no proxying of large buffers).

const bytesById = new Map()
let baseBytes = null
let nextId = 1

const state = reactive({
  channel: new URLSearchParams(location.search).get("channel") === "snapshot" ? "snapshot" : "release",
  baseId: "",
  baseStatus: "loading…",
  baseFailed: false,
  packs: [],
  busy: false,
  assetsVersion: 0
})

const assets = shallowRef(null)

const setChannelParam = ch => {
  const u = new URL(location)
  ch === "snapshot" ? u.searchParams.set("channel", "snapshot") : u.searchParams.delete("channel")
  history.replaceState(null, "", u)
}

// Rebuild the asset bundle from the current pack list. The previous bundle is
// disposed only AFTER `swap` resolves: the caller rebuilds its scene inside
// `swap`, so nothing still on screen loses its cached textures mid-frame.
async function rebuildAssets(swap) {
  const lib = await loadLibrary()
  const sources = [...state.packs.map(p => bytesById.get(p.id)), baseBytes].filter(Boolean)
  const prev = assets.value
  assets.value = sources.length ? await lib.prepareAssets(sources, { cache: true }) : null
  state.assetsVersion++
  try {
    await swap?.(assets.value)
  } finally {
    if (prev && prev !== assets.value) lib.disposeCache(prev)
  }
}

async function loadBase(swap) {
  state.busy = true
  state.baseFailed = false
  try {
    const mb = n => (n / 1048576).toFixed(0)
    const r = await loadMojangJar(state.channel, (got, total, ver) => {
      state.baseStatus = `downloading ${ver}… ${mb(got)}/${mb(total)}MB`
    })
    baseBytes = r.bytes
    state.baseId = r.id
    state.baseStatus = ""
  } catch (err) {
    console.warn("couldn't load the vanilla jar:", err)
    baseBytes = null
    state.baseId = ""
    state.baseStatus = "vanilla download failed"
    state.baseFailed = true
  }
  try {
    await rebuildAssets(swap)
  } finally {
    state.busy = false
  }
}

async function setChannel(channel, swap) {
  if (state.busy || channel === state.channel) return
  state.channel = channel
  setChannelParam(channel)
  await loadBase(swap)
}

async function addPacks(files, swap) {
  if (state.busy || !files.length) return
  state.busy = true
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
  }
}

async function removePack(id, swap) {
  if (state.busy) return
  const i = state.packs.findIndex(p => p.id === id)
  if (i < 0) return
  state.busy = true
  try {
    state.packs.splice(i, 1)
    bytesById.delete(id)
    await rebuildAssets(swap)
  } finally {
    state.busy = false
  }
}

async function movePack(id, delta, swap) {
  if (state.busy) return
  const i = state.packs.findIndex(p => p.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= state.packs.length) return
  state.busy = true
  try {
    const [p] = state.packs.splice(i, 1)
    state.packs.splice(j, 0, p)
    await rebuildAssets(swap)
  } finally {
    state.busy = false
  }
}

// Every zip source currently contributing files, highest priority first.
// Structure discovery scans the union of these (a pack's data/ may add
// structures the base doesn't have).
const allSources = () => [...state.packs.map(p => bytesById.get(p.id)), baseBytes].filter(Boolean)

export function usePacks() {
  return { state: readonly(state), assets, loadBase, setChannel, addPacks, removePack, movePack, allSources }
}
