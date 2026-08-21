import { reactive, readonly, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useComparePacks } from "./useComparePacks.js"
import { useStructures } from "./useStructures.js"
import { yieldTask } from "../yield.js"

// when the two stacks resolve to identical client assets, rendering the same
// nbt on both sides shows nothing, so the tree narrows to structures whose nbt
// genuinely changed and the features tab goes away. a DataVersion bump alone is
// not a change: every structure gets one each version

const packs = usePacks()
const comparePacks = useComparePacks()
const structures = useStructures()

// same: the two stacks' assets/ trees are identical; ready: the structure diff
// has finished, so `changed` is authoritative; rev bumps for reactivity
const state = reactive({ same: false, ready: false, rev: 0 })

let changedSet = new Set()
let tok = 0

const changed = rel => changedSet.has(rel)
// hide only once the sweep is done, so the tree never flashes empty mid-scan
const active = () => state.same && state.ready

function effectiveAssets(lib, sources) {
  const map = new Map()
  for (const src of sources) {
    for (const [path, e] of lib.parseZip(src)) {
      if (path.startsWith("assets/") && !map.has(path)) map.set(path, e)
    }
  }
  return map
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// identical content re-deflated by another writer can differ, which reads as
// "assets changed" and simply leaves the filter off: a safe miss
function sameAssetTrees(lib) {
  const a = effectiveAssets(lib, packs.zipSources())
  const b = effectiveAssets(lib, comparePacks.zipSources())
  if (a.size !== b.size) return false
  for (const [path, ea] of a) {
    const eb = b.get(path)
    if (!eb) return false
    if (ea !== eb && (ea.method !== eb.method || !bytesEqual(ea.data, eb.data))) return false
  }
  return true
}

async function gunzip(bytes) {
  if (!(bytes[0] === 0x1F && bytes[1] === 0x8B)) return bytes
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// TAG_Int, name length 11, "DataVersion": the 4 value bytes that follow
const DV = [0x03, 0x00, 0x0B, 0x44, 0x61, 0x74, 0x61, 0x56, 0x65, 0x72, 0x73, 0x69, 0x6F, 0x6E]

function dvRanges(buf) {
  const ranges = []
  outer: for (let i = 0; i + DV.length + 4 <= buf.length; i++) {
    for (let j = 0; j < DV.length; j++) if (buf[i + j] !== DV[j]) continue outer
    ranges.push([i + DV.length, i + DV.length + 4])
  }
  return ranges
}

function equalIgnoringDataVersion(a, b) {
  if (a.length !== b.length) return false
  const ranges = dvRanges(a)
  let r = 0
  for (let i = 0; i < a.length; i++) {
    while (r < ranges.length && i >= ranges[r][1]) r++
    if (r < ranges.length && i >= ranges[r][0] && i < ranges[r][1]) continue
    if (a[i] !== b[i]) return false
  }
  return true
}

async function computeChanged(lib, token) {
  const set = new Set()
  const mainAssets = packs.assets.value
  const names = structures.state.names
  for (let i = 0; i < names.length; i++) {
    if (token !== tok) return null
    if (i % 40 === 0) await yieldTask()
    const rel = names[i]
    const zp = structures.zipPathOf(rel)
    if (!zp || !comparePacks.has(rel)) continue
    try {
      const [a, b] = await Promise.all([lib.readFile(zp, mainAssets), comparePacks.readStructureBytes(rel)])
      if (!a || !b || bytesEqual(a, b)) continue
      const [ia, ib] = await Promise.all([gunzip(a), gunzip(b)])
      if (!equalIgnoringDataVersion(ia, ib)) set.add(rel)
    } catch {
      set.add(rel)
    }
  }
  return set
}

async function recompute() {
  const token = ++tok
  state.same = false
  state.ready = false
  changedSet = new Set()
  state.rev++
  if (!comparePacks.state.armed || !comparePacks.assets.value || !packs.assets.value) return
  const lib = await loadLibrary()
  if (token !== tok) return
  const same = sameAssetTrees(lib)
  if (token !== tok) return
  state.same = same
  if (!same) {
    state.ready = true
    state.rev++
    return
  }
  const set = await computeChanged(lib, token)
  if (token !== tok || !set) return
  changedSet = set
  state.ready = true
  state.rev++
}

watch([
  () => packs.state.assetsVersion,
  () => comparePacks.state.assetsVersion,
  () => structures.state.names.length
], recompute)

export function useCompareDiff() {
  return { state: readonly(state), active, changed }
}
