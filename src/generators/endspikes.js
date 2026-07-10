import { rnd, shuffle } from "../transforms.js"

// end spikes (EndSpikeFeature): ten obsidian pillars on a radius-42 ring.
// sizes 0-9 are shuffled per seed; radius 2 + size/3, height 76 + size*3,
// the two smallest guarded sizes (1 and 2) get iron bar cages. each pillar
// tops out with bedrock, fire and an end crystal. built in code: shapes are
// parametric, nothing to extract.

export async function runEndSpikes(loadStruct, { seed } = {}) {
  const rand = rnd(seed ?? (Math.random() * 0x100000000) >>> 0)
  const sizes = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], rand)

  const palette = []
  const palIdx = new Map()
  const stateFor = (Name, Properties) => {
    const pk = Name + "|" + JSON.stringify(Properties ?? null)
    let i = palIdx.get(pk)
    if (i === undefined) {
      i = palette.length
      palette.push(Properties ? { Name, Properties } : { Name })
      palIdx.set(pk, i)
    }
    return i
  }
  const obsidian = stateFor("minecraft:obsidian")
  const blocks = []
  const entities = []

  for (let i = 0; i < 10; i++) {
    const cx = Math.floor(42 * Math.cos(2 * (-Math.PI + Math.PI / 10 * i)))
    const cz = Math.floor(42 * Math.sin(2 * (-Math.PI + Math.PI / 10 * i)))
    const size = sizes[i]
    const radius = 2 + Math.floor(size / 3)
    const height = 76 + size * 3
    const guarded = size === 1 || size === 2

    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        if ((cx - x) * (cx - x) + (cz - z) * (cz - z) > radius * radius + 1) continue
        for (let y = 0; y < height; y++) blocks.push({ state: obsidian, pos: [x, y, z] })
      }
    }

    if (guarded) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          for (let dy = 0; dy <= 3; dy++) {
            const xSide = Math.abs(dx) === 2, zSide = Math.abs(dz) === 2, top = dy === 3
            if (!xSide && !zSide && !top) continue
            const xEdge = dx === -2 || dx === 2 || top
            const zEdge = dz === -2 || dz === 2 || top
            blocks.push({
              state: stateFor("minecraft:iron_bars", {
                north: String(xEdge && dz !== -2),
                south: String(xEdge && dz !== 2),
                west: String(zEdge && dx !== -2),
                east: String(zEdge && dx !== 2)
              }),
              pos: [cx + dx, height + dy, cz + dz]
            })
          }
        }
      }
    }

    blocks.push({ state: stateFor("minecraft:bedrock"), pos: [cx, height, cz] })
    blocks.push({ state: stateFor("minecraft:fire"), pos: [cx, height + 1, cz] })
    entities.push({ pos: [cx + 0.5, height + 1, cz + 0.5], nbt: { id: "minecraft:end_crystal" } })
  }

  const lo = [Infinity, 0, Infinity], hi = [-Infinity, 0, -Infinity]
  for (const b of blocks) {
    lo[0] = Math.min(lo[0], b.pos[0]); lo[2] = Math.min(lo[2], b.pos[2])
    hi[0] = Math.max(hi[0], b.pos[0]); hi[1] = Math.max(hi[1], b.pos[1]); hi[2] = Math.max(hi[2], b.pos[2])
  }
  for (const b of blocks) { b.pos = [b.pos[0] - lo[0], b.pos[1], b.pos[2] - lo[2]] }
  for (const e of entities) { e.pos = [e.pos[0] - lo[0], e.pos[1], e.pos[2] - lo[2]] }

  return {
    structure: {
      size: [hi[0] - lo[0] + 1, hi[1] + 1, hi[2] - lo[2] + 1],
      palette, blocks, entities,
      anchor: [-lo[0], 0, -lo[2]]
    },
    maxDepth: 1
  }
}
