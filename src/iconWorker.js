import { loadLibrary } from "./lib.js"
import { renderIcon } from "./iconRender.js"

let lib = null
let assets = null
const handles = new Map()
const players = new Map()

function drop(key) {
  handles.get(key)?.dispose?.()
  handles.delete(key)
  players.get(key)?.player?.dispose()
  players.delete(key)
}

self.onmessage = async e => {
  const m = e.data
  try {
    if (m.type === "init") {
      lib = await loadLibrary()
      assets = await lib.prepareAssets(m.sources, { cache: true })
      for (const key of Array.from(handles.keys())) drop(key)
      self.postMessage({ type: "init", id: m.id })
    } else if (m.type === "icon") {
      const out = assets ? await renderIcon(lib, assets, m.spec, { upgradable: true }) : null
      if (!out) {
        self.postMessage({ type: "icon", id: m.id })
        return
      }
      const animates = !!out.toAnimated
      const bitmap = await createImageBitmap(out.canvas ?? out)
      if (animates) {
        drop(m.key)
        handles.set(m.key, out)
      } else {
        out.dispose?.()
      }
      self.postMessage({ type: "icon", id: m.id, bitmap, animates }, [bitmap])
    } else if (m.type === "sync") {
      let entry = players.get(m.iconKey)
      if (!entry) players.set(m.iconKey, entry = { player: null, canvases: new Map() })
      for (const token of m.remove) entry.canvases.delete(token)
      for (let i = 0; i < m.addTokens.length; i++) entry.canvases.set(m.addTokens[i], m.addCanvases[i])
      const list = Array.from(entry.canvases.values())
      if (!list.length) {
        entry.player?.pause()
        return
      }
      if (entry.player) {
        entry.player.setCanvases(list)
        entry.player.play()
      } else {
        let handle = handles.get(m.iconKey)
        if (handle) handles.delete(m.iconKey)
        else handle = assets ? await renderIcon(lib, assets, m.spec, { upgradable: true }) : null
        entry.player = handle?.toAnimated?.(list) ?? null
        if (!entry.player) handle?.dispose?.()
      }
    } else if (m.type === "drop") {
      drop(m.iconKey)
    }
  } catch (err) {
    self.postMessage({ type: m.type, id: m.id, error: String(err?.message ?? err) })
  }
}
