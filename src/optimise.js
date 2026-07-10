// Thin wrapper over the library's optimizeScene: computes per-block cull sets
// (memoised on neighbour states, structures are repetitive) and hands the
// template groups over as placements. optimise(structure, templates,
// position, { lib, getCullFaces, setStatus }) -> { group, atlasTextures,
// drawCalls, tris }
const DIRS = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] }
const DIR_NAMES = Object.keys(DIRS)
const AIR = /(^|:)(air|cave_air|void_air|structure_void)$/

export async function optimise(structure, templates, position, { lib, getCullFaces, setStatus, setProgress, shouldCancel }) {
  setStatus?.("optimising…")
  setProgress?.(0, structure.blocks.length)
  await new Promise(r => setTimeout(r))

  // explicit air blocks (vanilla nbts fill their bounds with them) count as
  // absent everywhere: never placed, and a neighbour of air memoises the
  // same as no neighbour at all
  const isAir = structure.palette.map(e => AIR.test(e?.Name ?? ""))
  const posState = new Map()
  for (const b of structure.blocks) {
    if (!isAir[b.state]) posState.set(b.pos.join(","), b.state)
  }
  const cullMemo = new Map()
  const placements = []
  for (const b of structure.blocks) {
    if (isAir[b.state]) continue
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
      setStatus?.(`optimising… ${done}/${total}`)
      setProgress?.(done, total)
    },
    shouldCancel
  })
  if (!result) return null // cancelled; caller reverts, nothing GPU-side exists yet
  result.group.position.copy(position)
  return { group: result.group, atlasTextures: result.atlasTextures, drawCalls: result.drawCalls, tris: result.tris }
}
