import { reactive, readonly, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useComparePacks } from "./useComparePacks.js"
import { useStructures, STRUCT_RE } from "./useStructures.js"
import { numeric } from "../transforms.js"
import { yieldTask } from "../yield.js"
import { readStructure } from "../nbt.js"
import { sameStructure } from "../structdiff.js"

// what the comparison version did to the structure set: which files it gained,
// which it dropped, and which it rewrote. equal bytes settle it cheaply; the
// rest parse and compare on content, since a version can re-serialise every
// file (DataVersion bumps, the 26.3 blockstate field rename) without changing
// what any of them holds

const packs = usePacks()
const comparePacks = useComparePacks()
const structures = useStructures()

// ready: the nbt sweep has finished, so `changed` is authoritative. the other two
// lists come from the file names alone, so they land immediately
const state = reactive({ ready: false, progress: 0, counts: { new: 0, changed: 0, removed: 0 }, rev: 0 })

let lists = { new: [], changed: [], removed: [] }
let tok = 0

const list = kind => lists[kind]
const nothingDiffers = () => state.ready && !Object.values(state.counts).some(Boolean)

function publish() {
  for (const kind of Object.keys(lists)) state.counts[kind] = lists[kind].length
  state.rev++
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

async function computeChanged(lib, token, both) {
  const out = []
  const mainAssets = packs.assets.value
  for (let i = 0; i < both.length; i++) {
    if (token !== tok) return null
    if (i % 5 === 0) {
      state.progress = i / both.length
      await yieldTask()
    }
    const rel = both[i]
    try {
      const [a, b] = await Promise.all([
        lib.readFile(structures.zipPathOf(rel), mainAssets),
        comparePacks.readStructureBytes(rel)
      ])
      if (!a || !b || bytesEqual(a, b)) continue
      const [sa, sb] = await Promise.all([readStructure(a), readStructure(b)])
      if (!sameStructure(sa, sb)) out.push(rel)
    } catch {
      out.push(rel)
    }
  }
  return out
}

// the hardcoded structures and built features ship with the viewer, not with
// either version, so they are no version's doing
function viewerOwned(lib) {
  const set = new Set()
  for (const src of packs.builtinSources()) {
    for (const k of lib.parseZip(src).keys()) {
      const m = k.match(STRUCT_RE)
      if (m) set.add(m[1] + "/" + m[2])
    }
  }
  return set
}

async function recompute() {
  const token = ++tok
  state.ready = false
  state.progress = 0
  lists = { new: [], changed: [], removed: [] }
  publish()
  if (!comparePacks.state.armed || !comparePacks.assets.value || !packs.assets.value) return
  const lib = await loadLibrary()
  if (token !== tok) return
  // zip-backed names only, and none of the viewer's own: the rest is what the jars ship
  const ours = viewerOwned(lib)
  const mine = new Set(structures.state.names.filter(rel => structures.zipPathOf(rel) && !ours.has(rel)))
  const theirs = new Set(comparePacks.names())
  lists.new = Array.from(theirs).filter(rel => !mine.has(rel)).sort(numeric)
  lists.removed = Array.from(mine).filter(rel => !theirs.has(rel)).sort(numeric)
  publish()
  const both = Array.from(mine).filter(rel => theirs.has(rel)).sort(numeric)
  const changed = await computeChanged(lib, token, both)
  if (token !== tok || !changed) return
  lists.changed = changed
  state.progress = 1
  state.ready = true
  publish()
}

watch([
  () => packs.state.assetsVersion,
  () => comparePacks.state.assetsVersion,
  () => structures.state.names.length
], recompute)

export function useCompareDiff() {
  return { state: readonly(state), list, nothingDiffers }
}
