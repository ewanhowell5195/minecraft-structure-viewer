import { loadLibrary } from "./lib.js"
import { renderIcon } from "./iconRender.js"
import { usePacks } from "./composables/usePacks.js"

let _packs = null
const packs = () => _packs ??= usePacks()

const MAX = 1024

let worker = null
let ready = null
let dead = new URLSearchParams(location.search).has("mainbuild")
let seq = 0
const waiters = new Map()

const cache = new Map()
let version = -1

function settle(id, msg) {
  const w = waiters.get(id)
  if (!w) return
  waiters.delete(id)
  w(msg)
}

function call(msg) {
  return new Promise(resolve => {
    const id = ++seq
    waiters.set(id, resolve)
    worker.postMessage({ ...msg, id })
  })
}

function stop() {
  if (worker) {
    worker.terminate()
    worker = null
  }
  ready = null
  for (const id of Array.from(waiters.keys())) settle(id, null)
}

function start() {
  if (dead) return null
  if (!worker) {
    // a virtual source is a function object and can't cross into a worker, so
    // icons render on the main thread instead
    if (packs().virtualSources()) return null
    const sources = packs().allSources()
    if (!sources.length) return null
    try {
      worker = new Worker(new URL("./iconWorker.js", import.meta.url), { type: "module" })
    } catch {
      dead = true
      return null
    }
    worker.onmessage = e => settle(e.data.id, e.data)
    worker.onerror = () => { dead = true; stop() }
    ready = call({ type: "init", sources }).then(m => {
      if (m?.error) { dead = true; stop() }
      return !dead
    })
  }
  return ready
}

function checkVersion() {
  const v = packs().state.assetsVersion
  if (v === version) return
  version = v
  for (const p of cache.values()) p.then(b => b?.close?.(), () => {})
  cache.clear()
  stop()
}

function keyOf(spec) {
  return [
    version,
    spec.kind,
    spec.size,
    spec.id ?? spec.candidates?.join(",") ?? "",
    spec.components ? JSON.stringify(spec.components) : "",
    spec.blockstates ? JSON.stringify(spec.blockstates) : ""
  ].join("|")
}

async function renderMain(spec) {
  const lib = await loadLibrary()
  const assets = packs().assets.value
  if (!assets) return null
  try {
    const out = await renderIcon(lib, assets, spec, { upgradable: true })
    if (!out) return null
    const bitmap = await createImageBitmap(out.canvas ?? out)
    out.dispose?.()
    return { bitmap, animates: false }
  } catch {
    return null
  }
}

const plain = value => value == null ? value : JSON.parse(JSON.stringify(value))
const plainSpec = spec => ({ ...spec, components: plain(spec.components), blockstates: plain(spec.blockstates) })

async function produce(spec, key) {
  spec = plainSpec(spec)
  const ok = await start()
  if (ok && worker) {
    const m = await call({ type: "icon", spec, key })
    if (m) {
      if (m.error || !m.bitmap) return null
      return { bitmap: m.bitmap, animates: !!m.animates }
    }
  }
  return renderMain(spec)
}

export function iconInfo(spec) {
  checkVersion()
  const key = keyOf(spec)
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const p = produce(spec, key).catch(() => null)
  p.then(v => { if (!v && cache.get(key) === p) cache.delete(key) })
  cache.set(key, p)
  if (cache.size > MAX) {
    const oldest = cache.keys().next().value
    cache.get(oldest).then(v => v?.bitmap?.close?.(), () => {})
    cache.delete(oldest)
    dropTargets(oldest)
  }
  return p
}

export function iconBitmap(spec) {
  return iconInfo(spec).then(v => v?.bitmap ?? null)
}

const idle = globalThis.requestIdleCallback ?? (fn => setTimeout(fn, 200))

export function warmIcons() {
  idle(() => {
    checkVersion()
    start()
  })
}

const anim = new Map()
let tokenSeq = 0

export const nextToken = () => ++tokenSeq

function scheduleSync(key) {
  const entry = anim.get(key)
  if (!entry || entry.queued) return
  entry.queued = true
  queueMicrotask(async () => {
    entry.queued = false
    await sync(key)
  })
}

async function sync(key) {
  const entry = anim.get(key)
  if (!entry) return
  const ok = await start()
  if (!ok || !worker || !anim.has(key)) return
  const addTokens = []
  const addCanvases = []
  const transfer = []
  for (const [token, canvas] of entry.targets) {
    if (entry.sent.has(token)) continue
    let off
    try {
      off = canvas.transferControlToOffscreen()
    } catch {
      entry.targets.delete(token)
      continue
    }
    entry.sent.add(token)
    addTokens.push(token)
    addCanvases.push(off)
    transfer.push(off)
  }
  const remove = Array.from(entry.sent).filter(t => !entry.targets.has(t))
  for (const t of remove) entry.sent.delete(t)
  if (!addTokens.length && !remove.length) return
  try {
    worker.postMessage({ type: "sync", iconKey: key, spec: plainSpec(entry.spec), addTokens, addCanvases, remove }, transfer)
  } catch {
  }
}

export async function acquireIcon(spec, token, size) {
  const info = await iconInfo(spec)
  if (!info) return null
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = size
  if (!info.animates) {
    canvas.getContext("2d").drawImage(info.bitmap, 0, 0)
    return { canvas, animated: false }
  }
  const key = keyOf(spec)
  let entry = anim.get(key)
  if (!entry) anim.set(key, entry = { spec, targets: new Map(), sent: new Set(), queued: false })
  entry.targets.set(token, canvas)
  scheduleSync(key)
  return { canvas, animated: true }
}

export function releaseIcon(spec, token) {
  const key = keyOf(spec)
  const entry = anim.get(key)
  if (!entry || !entry.targets.delete(token)) return
  scheduleSync(key)
}

function dropTargets(key) {
  anim.delete(key)
  if (worker) worker.postMessage({ type: "drop", iconKey: key })
}

let observer = null
const pending = new WeakMap()

export function onVisible(target, fn) {
  if (!target) return
  observer ??= new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue
      observer.unobserve(en.target)
      const cb = pending.get(en.target)
      pending.delete(en.target)
      cb?.()
    }
  })
  pending.set(target, fn)
  observer.observe(target)
}

export function offVisible(target) {
  if (!target) return
  observer?.unobserve(target)
  pending.delete(target)
}
