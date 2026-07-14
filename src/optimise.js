import { yieldTask } from "./yield.js"

const DIRS = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] }
const DIR_NAMES = Object.keys(DIRS)
const AIR = /(^|:)(air|cave_air|void_air|structure_void)$/

export async function optimise(structure, templates, position, { lib, getCullFaces, setStatus, setProgress, shouldCancel }) {
  setStatus?.("optimising…")
  // one 0..10000 sweep across both passes so the bar never animates backwards
  setProgress?.(0, 10000)
  await yieldTask()

  // vanilla nbts fill their bounds with explicit air blocks; treat them as absent
  const isAir = structure.palette.map(e => AIR.test(e?.Name ?? ""))
  const posState = new Map()
  for (const b of structure.blocks) {
    if (!isAir[b.state]) posState.set(b.pos.join(","), b.state)
  }
  const cullMemo = new Map()
  const placements = []
  let nonAirTotal = 0
  for (const b of structure.blocks) if (!isAir[b.state]) nonAirTotal++
  let seen = 0
  for (const b of structure.blocks) {
    if (isAir[b.state]) continue
    // cached cull lookups resolve as microtasks; the loop needs real yields
    if (++seen % 2000 === 0) {
      setStatus?.(`optimising… culling ${seen}/${nonAirTotal}`)
      setProgress?.(Math.round(seen / nonAirTotal * 1000), 10000)
      await yieldTask()
      if (shouldCancel?.()) return null
    }
    const entry = structure.palette[b.state]
    const tmpl = templates.get(b.state)
    if (!entry?.Name || !tmpl) continue
    const nStates = DIR_NAMES.map(dir => {
      const [dx, dy, dz] = DIRS[dir]
      return posState.get((b.pos[0] + dx) + "," + (b.pos[1] + dy) + "," + (b.pos[2] + dz))
    })
    const mkey = b.state + "|" + nStates.join(",")
    let cull = cullMemo.get(mkey)
    if (cull === undefined) {
      const neighbors = {}
      for (let i = 0; i < 6; i++) {
        const ne = nStates[i] === undefined ? null : structure.palette[nStates[i]]
        if (ne?.Name) neighbors[DIR_NAMES[i]] = { id: ne.Name, ...(ne.Properties ?? {}) }
      }
      cull = await getCullFaces({ id: entry.Name, blockstates: entry.Properties ?? {}, neighbors })
      cullMemo.set(mkey, cull)
    }
    placements.push({ pos: b.pos, group: tmpl, cull })
  }

  const result = await lib.optimizeScene(placements, {
    onProgress: (done, total) => {
      const f = done / total
      setStatus?.(`optimising… ${Math.round(f * 100)}%`)
      setProgress?.(1000 + Math.round(f * 9000), 10000)
    },
    shouldCancel
  })
  if (!result) return null
  result.group.position.copy(position)
  return { group: result.group, atlasTextures: result.atlasTextures, drawCalls: result.drawCalls, tris: result.tris }
}
