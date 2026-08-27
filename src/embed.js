import { watch } from "vue"
import { usePacks } from "./composables/usePacks.js"
import { useStructure } from "./composables/useStructure.js"
import { useStructures } from "./composables/useStructures.js"
import { useWorld } from "./composables/useWorld.js"
import { useBuild } from "./composables/useBuild.js"
import { useCompare } from "./composables/useCompare.js"
import { useComparePacks } from "./composables/useComparePacks.js"
import { setHighlights } from "./composables/useHighlight.js"
import { useSky } from "./composables/useSky.js"
import { read } from "minecraft-block-reader"

const SOURCE = "structure-viewer"
const AIR = /(^|:)(air|cave_air|void_air)$/
const TIMEOUT = 30000

const isCommand = data => data?.source === SOURCE && typeof data.type === "string"

function reply(event, id, body) {
  if (id === undefined) return
  event.source?.postMessage({ source: SOURCE, reply: id, ...body }, event.origin === "null" ? "*" : event.origin)
}

export function emit(type, body = {}) {
  parent?.postMessage({ source: SOURCE, event: type, ...body }, "*")
}

let nextRequest = 1
const waiting = new Map()

function ask(handler, op, path) {
  const request = nextRequest++
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waiting.delete(request)
      resolve(null)
    }, TIMEOUT)
    waiting.set(request, message => {
      clearTimeout(timer)
      resolve(message)
    })
    parent?.postMessage({ source: SOURCE, request, handler, op, path }, "*")
  })
}

async function toBytes(data) {
  if (data == null) return null
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data.arrayBuffer) return new Uint8Array(await data.arrayBuffer())
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

// a source the page serves file by file. answers are memoised: the library asks
// for the same model and texture repeatedly, and every miss is a round trip
export function makeHandler(id) {
  const reads = new Map()
  const lists = new Map()
  return {
    read(path) {
      let pending = reads.get(path)
      if (!pending) reads.set(path, pending = ask(id, "read", path).then(m => toBytes(m?.data)))
      return pending
    },
    list(dir) {
      let pending = lists.get(dir)
      if (!pending) lists.set(dir, pending = ask(id, "list", dir).then(m => Array.isArray(m?.names) ? m.names : []))
      return pending
    }
  }
}

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString()
  if (ArrayBuffer.isView(value)) return Array.from(value)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]))
  }
  return value
}

async function readFileStructure(data, name = "structure.nbt") {
  const bytes = await toBytes(data)
  if (!bytes) throw new Error("getBlocks needs structure bytes in data")
  return read(bytes)
}

function toFile(data, name = "structure.nbt") {
  if (data instanceof File) return data
  if (data instanceof Blob) return new File([data], name)
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return new File([bytes], name)
}

const COMMANDS = {
  async loadPacks({ base, packs }) {
    await usePacks().loadPacks({ base, packs })
  },
  async loadStructure({ data, name, path }) {
    const structure = useStructure()
    if (data !== undefined) {
      await structure.loadFile(toFile(data, name), false)
    } else if (path) {
      if (!useStructures().has(path)) throw new Error(`structure not found: ${path}`)
      await structure.loadVanilla(path)
    } else {
      throw new Error("loadStructure needs data or path")
    }
    if (structure.state.error) throw new Error(structure.state.error)
  },
  listStructures({ filter } = {}) {
    const names = useStructures().state.names
    return { names: filter ? names.filter(n => n.includes(filter)) : names.slice() }
  },
  async loadWorld({ data, name, dimension, chunks, y, force }) {
    const world = useWorld()
    if (data !== undefined) {
      await world.openWorld(toFile(data, name ?? "world.zip"), false)
      if (world.state.error) throw new Error(world.state.error)
    }
    if (!world.getWorld()) throw new Error("no world open: pass data")
    if (dimension && dimension !== world.state.dimension) {
      await world.setDimension(dimension)
      if (world.state.error) throw new Error(world.state.error)
    }
    const report = () => ({
      chunks: world.state.selCount,
      dimensions: world.state.dimensions.slice(),
      bounds: worldBounds(world)
    })
    if (chunks === undefined) return report()

    world.clearSelection()
    selectChunks(world, chunks)
    if (!world.state.selCount) throw new Error("none of those chunks are in this world")
    if (y) world.setYRange(Number(y[0]), Number(y[1]))
    else await world.applySuggestedRange()
    if (!force && world.loadForecast()) {
      const { yMin, yMax } = world.state
      throw new Error(`${world.state.selCount} chunks over y ${yMin} to ${yMax} may exhaust memory; pass force to build it anyway`)
    }
    await world.loadSelected(force)
    if (world.state.error) throw new Error(world.state.error)
    return report()
  },
  highlight({ blocks }) {
    return { count: setHighlights(blocks) }
  },
  async getBlocks({ data, name } = {}) {
    const structure = data !== undefined
      ? await readFileStructure(data, name)
      : useBuild().current.value
    if (!structure) throw new Error("nothing is loaded")
    const blocks = []
    for (const b of structure.blocks) {
      const entry = structure.palette[b.state]
      if (!entry?.id || AIR.test(entry.id)) continue
      const out = { pos: b.pos.slice(), id: entry.id }
      if (entry.properties) out.properties = { ...entry.properties }
      if (b.nbt) out.nbt = jsonSafe(b.nbt)
      blocks.push(out)
    }
    const entities = (structure.entities ?? []).map(e => ({
      pos: e.pos.slice(),
      id: e.nbt?.id ?? "",
      nbt: jsonSafe(e.nbt ?? {})
    }))
    return { blocks, entities }
  },
  sky({ on } = {}) {
    const sky = useSky()
    if (on !== undefined) sky.enabled.value = !!on
    return { on: sky.enabled.value, active: sky.active.value }
  },
  async loadComparePacks({ base, packs } = {}) {
    const comparePacks = useComparePacks()
    await compareIdle()
    if (base === null && Array.isArray(packs) && !packs.length) {
      await useCompare().stop()
    } else {
      await comparePacks.loadSources({ base, packs })
    }
    return { armed: comparePacks.state.armed, version: comparePacks.state.baseId }
  },
  async compare({ off, path, against, left, right, show, view, split, labels } = {}) {
    const compare = useCompare()
    const comparePacks = useComparePacks()
    await compareIdle()
    const armed = () => {
      if (!comparePacks.state.armed) throw new Error("no comparison assets: call loadComparePacks first")
    }
    if (off) {
      await compare.leave()
    } else if (against !== undefined) {
      if (!useStructures().has(against)) throw new Error(`structure not found: ${against}`)
      if (path) await COMMANDS.loadStructure({ path })
      await compare.enter(against)
      if (!compare.state.on) throw new Error("nothing to compare against: load a different structure first")
    } else if (left !== undefined || right !== undefined) {
      armed()
      const asFile = v => v == null ? null : toFile(v?.data ?? v, v?.name)
      await compare.setFiles(asFile(left), asFile(right))
    } else if (path) {
      armed()
      if (!useStructures().has(path) && !comparePacks.has(path)) {
        throw new Error(`structure not found on either side: ${path}`)
      }
      await compare.openVersion(path)
    }
    if (show) {
      for (const kind of ["added", "changed", "removed"]) {
        if (kind in show) compare.stateMut.show[kind] = !!show[kind]
      }
    }
    if (view !== undefined) {
      if (!["slide", "before", "after"].includes(view)) throw new Error(`unknown view: ${view}`)
      compare.stateMut.view = view
    }
    if (typeof split === "number") compare.stateMut.split = Math.min(Math.max(split, 0), 1)
    if (labels !== undefined) {
      if (!Array.isArray(labels) || labels.length > 2) throw new Error("labels must be [left, right]")
      const [l, r] = labels
      if (typeof l === "string" && l) compare.stateMut.left = l
      if (typeof r === "string" && r) compare.stateMut.right = r
    }
    const { on, mode, counts, left: leftLabel, right: rightLabel } = compare.state
    return { on, mode, counts: { ...counts }, labels: [leftLabel, rightLabel] }
  }
}

// arming fires useCompare's auto-enter, so a command right behind it would hit
// the entering guard and silently no-op
function compareIdle() {
  const compare = useCompare()
  const build = useBuild()
  const idle = () => !compare.busy() && !build.state.building
  if (idle()) return Promise.resolve()
  return new Promise(resolve => {
    const stop = watch([() => compare.busy(), () => build.state.building], () => {
      if (!idle()) return
      stop()
      resolve()
    })
  })
}

const isPair = v => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === "number")

function selectChunks(world, chunks) {
  if (!Array.isArray(chunks) || !chunks.length) throw new Error("chunks must be an array of [x, z] pairs")
  if (!chunks.every(isPair)) throw new Error("chunks must be [x, z] pairs")
  // two pairs are opposite corners; anything else is the exact list
  if (chunks.length === 2) {
    world.selectRect(chunks[0][0], chunks[0][1], chunks[1][0], chunks[1][1])
    return
  }
  const have = new Set(world.getChunks().map(c => c.cx + "," + c.cz))
  for (const [cx, cz] of chunks) {
    const key = cx + "," + cz
    if (have.has(key)) world.toggleChunk(key, true)
  }
}

function worldBounds(world) {
  let minCx = Infinity, maxCx = -Infinity, minCz = Infinity, maxCz = -Infinity
  for (const c of world.getChunks()) {
    if (c.cx < minCx) minCx = c.cx
    if (c.cx > maxCx) maxCx = c.cx
    if (c.cz < minCz) minCz = c.cz
    if (c.cz > maxCz) maxCz = c.cz
  }
  return Number.isFinite(minCx) ? { minCx, maxCx, minCz, maxCz } : null
}

export function initEmbedApi() {
  usePacks().setHandlerFactory(makeHandler)
  useComparePacks().setHandlerFactory(makeHandler)
  addEventListener("message", async event => {
    const data = event.data
    if (data?.source !== SOURCE) return
    if (data.response !== undefined) {
      const settle = waiting.get(data.response)
      if (settle) {
        waiting.delete(data.response)
        settle(data)
      }
      return
    }
    if (!isCommand(data)) return
    const command = COMMANDS[data.type]
    if (!command) {
      reply(event, data.id, { ok: false, error: `unknown command: ${data.type}` })
      return
    }
    try {
      const result = await command(data)
      reply(event, data.id, { ok: true, ...result })
    } catch (err) {
      reply(event, data.id, { ok: false, error: String(err?.message ?? err) })
    }
  })
  emit("ready")
}
