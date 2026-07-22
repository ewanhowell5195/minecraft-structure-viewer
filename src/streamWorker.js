// chunk parsing for world streaming: zip inflate, NBT decode and palette
// unpacking happen here so tile builds stop stealing main-thread frames
import { readWorldZip, switchDimension, chunkBlocks } from "./world.js"

let world = null
let range = null
let chunkMap = null

self.onmessage = async e => {
  const m = e.data
  try {
    if (m.type === "init") {
      world = await readWorldZip(m.file)
      if (m.dimension && m.dimension !== world.dimension) world = await switchDimension(world, m.dimension)
      range = { yMin: m.yMin, yMax: m.yMax }
      chunkMap = new Map(world.chunks.map(c => [c.cx + "," + c.cz, c]))
      self.postMessage({ type: "ready", id: m.id })
    } else if (m.type === "chunk") {
      const c = chunkMap.get(m.cx + "," + m.cz)
      const blocks = c ? await chunkBlocks(world, c, range) : []
      self.postMessage({ type: "chunk", id: m.id, blocks })
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, error: String(err?.message ?? err) })
  }
}
