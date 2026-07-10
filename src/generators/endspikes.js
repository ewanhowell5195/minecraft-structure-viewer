import { rnd, shuffle } from "../transforms.js"

// end spikes (EndSpikeFeature): obsidian pillars, radius 2 + size/3, height
// 76 + size*3, iron bar cages on the two smallest guarded sizes (1 and 2),
// bedrock + fire + an end crystal on top. built in code: the shapes are
// parametric. the full ring puts the ten shuffled sizes around the exit
// portal; the single spike entries roll one size of their kind.

// the podium's portal ring sits at the End's surface height
const PORTAL_Y = 62

function statePicker() {
  const palette = [], palIdx = new Map()
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
  return { palette, stateFor }
}

function buildSpike(stateFor, blocks, entities, cx, cz, size) {
  const radius = 2 + Math.floor(size / 3)
  const height = 76 + size * 3
  const guarded = size === 1 || size === 2
  const obsidian = stateFor("minecraft:obsidian")

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

function normalise(palette, blocks, entities) {
  const lo = [Infinity, 0, Infinity], hi = [-Infinity, 0, -Infinity]
  for (const b of blocks) {
    lo[0] = Math.min(lo[0], b.pos[0]); lo[2] = Math.min(lo[2], b.pos[2])
    hi[0] = Math.max(hi[0], b.pos[0]); hi[1] = Math.max(hi[1], b.pos[1]); hi[2] = Math.max(hi[2], b.pos[2])
  }
  for (const b of blocks) { b.pos = [b.pos[0] - lo[0], b.pos[1], b.pos[2] - lo[2]] }
  for (const e of entities) { e.pos = [e.pos[0] - lo[0], e.pos[1], e.pos[2] - lo[2]] }
  return {
    size: [hi[0] - lo[0] + 1, hi[1] + 1, hi[2] - lo[2] + 1],
    palette, blocks, entities,
    anchor: [-lo[0], 0, -lo[2]]
  }
}

export const makeEndSpikes = active => async (loadStruct, { seed } = {}) => {
  const rand = rnd(seed ?? (Math.random() * 0x100000000) >>> 0)
  const sizes = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], rand)
  const { palette, stateFor } = statePicker()
  const blocks = [], entities = []

  for (let i = 0; i < 10; i++) {
    const cx = Math.floor(42 * Math.cos(2 * (-Math.PI + Math.PI / 10 * i)))
    const cz = Math.floor(42 * Math.sin(2 * (-Math.PI + Math.PI / 10 * i)))
    buildSpike(stateFor, blocks, entities, cx, cz, sizes[i])
  }

  // the exit portal at the ring's centre
  const portal = await loadStruct("builtin/end/exit_portal/" + (active ? "active" : "inactive"))
  let off = [0, 0, 0]
  if (portal) {
    off = [-Math.floor(portal.size[0] / 2), PORTAL_Y, -Math.floor(portal.size[2] / 2)]
    const map = portal.palette.map(e => stateFor(e.Name, e.Properties))
    for (const b of portal.blocks) {
      const block = { state: map[b.state], pos: [b.pos[0] + off[0], b.pos[1] + off[1], b.pos[2] + off[2]] }
      if (b.nbt) block.nbt = b.nbt
      blocks.push(block)
    }
  }

  // anchor on the portal (the base nbt's origin) so the camera stays with it
  const structure = normalise(palette, blocks, entities)
  structure.anchor = [off[0] + structure.anchor[0], off[1], off[2] + structure.anchor[2]]
  return { structure, maxDepth: 1 }
}

export const runEndSpikes = makeEndSpikes(false)
export const runEndSpikesActive = makeEndSpikes(true)

const CAGED_SIZES = [1, 2]
const OPEN_SIZES = [0, 3, 4, 5, 6, 7, 8, 9]

export const makeEndSpike = caged => async (loadStruct, { seed } = {}) => {
  const rand = rnd(seed ?? (Math.random() * 0x100000000) >>> 0)
  const pool = caged ? CAGED_SIZES : OPEN_SIZES
  const size = pool[Math.floor(rand() * pool.length)]
  const { palette, stateFor } = statePicker()
  const blocks = [], entities = []
  buildSpike(stateFor, blocks, entities, 0, 0, size)
  return { structure: normalise(palette, blocks, entities), maxDepth: 1 }
}

export const runEndSpike = makeEndSpike(false)
export const runEndSpikeCaged = makeEndSpike(true)
