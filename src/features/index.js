// ports of the game's placement code over an empty world: the viewer's floor grid is the ground
import { nextInt, sampleFloat, sampleInt, sampleState, pickWeighted, intBounds } from "./providers.js"
import { generateTree, generateFallenTree } from "./tree.js"
import { runEndSpike } from "../generators/endspikes.js"
import { DIR, HORIZ, OPP, statePicker } from "../transforms.js"

const strip = t => (t ?? "").replace("minecraft:", "")

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => x + "," + y + "," + z
  return {
    cells,
    get: (x, y, z) => cells.get(key(x, y, z)),
    set: (x, y, z, state) => { if (state && y > -64) cells.set(key(x, y, z), state) },
    remove: (x, y, z) => cells.delete(key(x, y, z))
  }
}

async function generate(world, json, rand, resolvePlaced, ox = 0, oy = 0, oz = 0) {
  const type = strip(json.type)
  const gen = TYPES[type]
  if (!gen) throw new Error(`feature type ${json.type} isn't supported yet`)
  await gen(world, json, rand, resolvePlaced, ox, oy, oz)
}

const TYPES = {
  async tree(world, json, rand, resolvePlaced) {
    const sub = makeWorld()
    const pending = []
    const runFeature = (id, x, y, z) => {
      if (!resolvePlaced) return
      pending.push((async () => {
        const inner = await resolvePlaced(id)
        if (inner) await generate(sub, inner, rand, resolvePlaced, x, y, z)
      })())
    }
    generateTree(sub, json, rand, { runFeature })
    await Promise.all(pending)
    for (const [k, v] of sub.cells) world.cells.set(k, v)
  },

  async fallen_tree(world, json, rand) {
    const sub = makeWorld()
    generateFallenTree(sub, json, rand)
    for (const [k, v] of sub.cells) world.cells.set(k, v)
  },

  async simple_block(world, json, rand, resolvePlaced, ox, oy, oz) {
    const state = sampleState(json.to_place, rand)
    if (!state) return
    const name = strip(state.Name)
    if (/^(tall_grass|large_fern|tall_seagrass|sunflower|lilac|rose_bush|peony|pitcher_plant|small_dripleaf)$/.test(name)) {
      world.set(ox, oy, oz, { Name: state.Name, Properties: { ...(state.Properties ?? {}), half: "lower" } })
      if (!world.get(ox, oy + 1, oz)) world.set(ox, oy + 1, oz, { Name: state.Name, Properties: { ...(state.Properties ?? {}), half: "upper" } })
    } else {
      world.set(ox, oy, oz, state)
    }
  },

  async block_column(world, json, rand, resolvePlaced, ox, oy, oz) {
    const dir = strip(json.direction) === "down" ? -1 : 1
    let y = oy
    for (const layer of json.layers) {
      const height = sampleInt(layer.height, rand)
      for (let i = 0; i < height; i++) {
        if (world.get(ox, y, oz)) return
        world.set(ox, y, oz, sampleState(layer.provider, rand))
        y += dir
      }
    }
  },

  async bamboo(world, json, rand, resolvePlaced, ox, oy, oz) {
    const height = nextInt(rand, 12) + 5
    if (rand() < (json.probability ?? 0)) {
      const podzolRadius = nextInt(rand, 4) + 1
      for (let dx = -podzolRadius; dx <= podzolRadius; dx++) for (let dz = -podzolRadius; dz <= podzolRadius; dz++) {
        if (dx * dx + dz * dz <= podzolRadius * podzolRadius) world.set(ox + dx, oy - 1, oz + dz, { Name: "minecraft:podzol", Properties: { snowy: "false" } })
      }
    }
    for (let i = 0; i < height; i++) {
      world.set(ox, oy + i, oz, { Name: "minecraft:bamboo", Properties: { age: "1", leaves: "none", stage: "0" } })
    }
    world.set(ox, oy + height, oz, { Name: "minecraft:bamboo", Properties: { age: "1", leaves: "large", stage: "1" } })
    world.set(ox, oy + height - 1, oz, { Name: "minecraft:bamboo", Properties: { age: "1", leaves: "large", stage: "0" } })
    world.set(ox, oy + height - 2, oz, { Name: "minecraft:bamboo", Properties: { age: "1", leaves: "small", stage: "0" } })
  },

  async block_pile(world, json, rand, resolvePlaced, ox, oy, oz) {
    const rx = 2 + nextInt(rand, 2), rz = 2 + nextInt(rand, 2)
    for (let dz = -rz; dz <= rz; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          const d = dx * dx + dz * dz
          const hit = d <= rand() * 10 - rand() * 6 || rand() < 0.031
          if (!hit) continue
          if (world.get(ox + dx, oy + dy, oz + dz)) continue
          if (dy === 1 && !world.get(ox + dx, oy, oz + dz)) continue
          world.set(ox + dx, oy + dy, oz + dz, sampleState(json.state_provider, rand))
        }
      }
    }
  },

  async huge_red_mushroom(world, json, rand, resolvePlaced, ox, oy, oz) {
    const height = mushroomHeight(rand)
    const r = json.foliage_radius ?? 2
    const center = r - 2
    for (let dy = height - 3; dy <= height; dy++) {
      const radius = dy < height ? r : r - 1
      for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
        const xEdge = dx === -radius || dx === radius
        const zEdge = dz === -radius || dz === radius
        if (dy < height && xEdge === zEdge) continue
        world.set(ox + dx, oy + dy, oz + dz, mushroomCap(json.cap_provider, rand, {
          up: dy >= height - 1, west: dx < -center, east: dx > center, north: dz < -center, south: dz > center
        }))
      }
    }
    for (let dy = 0; dy < height; dy++) {
      if (!world.get(ox, oy + dy, oz)) world.set(ox, oy + dy, oz, sampleState(json.stem_provider, rand))
    }
  },

  async huge_brown_mushroom(world, json, rand, resolvePlaced, ox, oy, oz) {
    const height = mushroomHeight(rand)
    const r = json.foliage_radius ?? 2
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const minX = dx === -r, maxX = dx === r, minZ = dz === -r, maxZ = dz === r
      const xEdge = minX || maxX, zEdge = minZ || maxZ
      if (xEdge && zEdge) continue
      world.set(ox + dx, oy + height, oz + dz, mushroomCap(json.cap_provider, rand, {
        up: true,
        west: minX || zEdge && dx === 1 - r,
        east: maxX || zEdge && dx === r - 1,
        north: minZ || xEdge && dz === 1 - r,
        south: maxZ || xEdge && dz === r - 1
      }))
    }
    for (let dy = 0; dy < height; dy++) {
      if (!world.get(ox, oy + dy, oz)) world.set(ox, oy + dy, oz, sampleState(json.stem_provider, rand))
    }
  },

  async disk(world, json, rand, resolvePlaced, ox, oy, oz) {
    const radius = sampleInt(json.radius, rand)
    const layers = Math.max(1, json.half_height ?? 0)
    const provider = json.state_provider?.fallback ?? json.state_provider
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue
      for (let dy = 1; dy <= layers; dy++) {
        world.set(ox + dx, oy - dy, oz + dz, sampleState(provider, rand))
      }
    }
  },

  // lifted by the blob's own maximum extent so the body sits on the grid
  async ore(world, json, rand, resolvePlaced, ox, oy, oz) {
    const size = json.size ?? 9
    const state = json.targets?.[0]?.state ?? sampleState(json.state_provider, rand)
    if (!state) return
    const dir = rand() * Math.PI
    const spread = size / 8
    const maxRadius = Math.ceil((size / 16 * 2 + 1) / 2)
    const lift = 2 + maxRadius
    const x0 = Math.sin(dir) * spread, x1 = -Math.sin(dir) * spread
    const z0 = Math.cos(dir) * spread, z1 = -Math.cos(dir) * spread
    const y0 = nextInt(rand, 3) - 2, y1 = nextInt(rand, 3) - 2
    let placed = 0
    for (let i = 0; i < size; i++) {
      const t = i / size
      const cx = x0 + (x1 - x0) * t
      const cy = y0 + (y1 - y0) * t
      const cz = z0 + (z1 - z0) * t
      const radius = ((Math.sin(Math.PI * t) + 1) * (rand() * size / 16) + 1) / 2
      const r = Math.ceil(radius)
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        const px = Math.floor(cx) + dx, py = Math.floor(cy) + dy, pz = Math.floor(cz) + dz
        const ddx = px + 0.5 - cx, ddy = py + 0.5 - cy, ddz = pz + 0.5 - cz
        if (ddx * ddx + ddy * ddy + ddz * ddz > radius * radius) continue
        world.set(ox + px, oy + py + lift, oz + pz, state)
        placed++
      }
    }
    if (!placed) world.set(ox, oy, oz, state)
  },

  async scattered_ore(world, json, rand, resolvePlaced, ox, oy, oz) {
    const size = json.size ?? 9
    const state = json.targets?.[0]?.state ?? sampleState(json.state_provider, rand)
    if (!state) return
    const tries = nextInt(rand, size + 1)
    let placed = 0
    for (let i = 0; i < tries; i++) {
      const d = Math.min(i, 7)
      const dx = Math.round((rand() - rand()) * d)
      const dy = Math.round((rand() - rand()) * d)
      const dz = Math.round((rand() - rand()) * d)
      if (world.get(ox + dx, oy + dy, oz + dz)) continue
      world.set(ox + dx, oy + dy, oz + dz, state)
      placed++
    }
    if (!placed) world.set(ox, oy, oz, state)
  },

  async nether_forest_vegetation(world, json, rand, resolvePlaced, ox, oy, oz) {
    const w = json.spread_width
    for (let i = 0; i < w * w; i++) {
      const dx = nextInt(rand, w) - nextInt(rand, w)
      const dz = nextInt(rand, w) - nextInt(rand, w)
      if (world.get(ox + dx, oy, oz + dz)) continue
      const state = sampleState(json.state_provider, rand)
      if (state) world.set(ox + dx, oy, oz + dz, state)
    }
  },

  async twisting_vines(world, json, rand, resolvePlaced, ox, oy, oz) {
    const w = json.spread_width
    for (let i = 0; i < w * w; i++) {
      const dx = nextInt(rand, 2 * w + 1) - w
      const dz = nextInt(rand, 2 * w + 1) - w
      if (world.get(ox + dx, oy, oz + dz)) continue
      let height = nextInt(rand, json.max_height ?? 8) + 1
      if (nextInt(rand, 6) === 0) height *= 2
      if (nextInt(rand, 5) === 0) height = 1
      for (let y = 0; y < height; y++) {
        world.set(ox + dx, oy + y, oz + dz, { Name: y === height - 1 ? "minecraft:twisting_vines" : "minecraft:twisting_vines_plant", ...(y === height - 1 ? { Properties: { age: "0" } } : {}) })
      }
    }
  },

  // ceiling patches hang from a virtual ceiling 10 up, so the vines reach the grid
  async vegetation_patch(world, json, rand, resolvePlaced, ox, oy, oz, waterlogged) {
    const ceiling = strip(json.surface ?? "floor") === "ceiling"
    const dir = ceiling ? 1 : -1
    const topY = ceiling ? oy + 9 : oy - 1
    const rx = sampleInt(json.xz_radius, rand) + 1
    const rz = sampleInt(json.xz_radius, rand) + 1
    const edgeChance = json.extra_edge_column_chance ?? 0.3
    const cols = []
    for (let dx = -rx; dx <= rx; dx++) {
      const xEdge = dx === -rx || dx === rx
      for (let dz = -rz; dz <= rz; dz++) {
        const zEdge = dz === -rz || dz === rz
        if (xEdge && zEdge) continue
        if ((xEdge || zEdge) && (edgeChance === 0 || rand() > edgeChance)) continue
        let depth = sampleInt(json.depth, rand)
        if ((json.extra_bottom_block_chance ?? 0) > 0 && rand() < json.extra_bottom_block_chance) depth++
        for (let i = 0; i < depth; i++) {
          world.set(ox + dx, topY + i * dir, oz + dz, sampleState(json.ground_state, rand))
        }
        cols.push([dx, dz])
      }
    }
    let surface = cols
    if (waterlogged) {
      const placed = new Set(cols.map(([dx, dz]) => dx + "," + dz))
      surface = cols.filter(([dx, dz]) =>
        placed.has((dx + 1) + "," + dz) && placed.has((dx - 1) + "," + dz) &&
        placed.has(dx + "," + (dz + 1)) && placed.has(dx + "," + (dz - 1)))
      for (const [dx, dz] of surface) {
        world.set(ox + dx, topY, oz + dz, { Name: "minecraft:water", Properties: { level: "0" } })
      }
    }
    for (const [dx, dz] of surface) {
      if ((json.vegetation_chance ?? 0) <= 0 || rand() >= json.vegetation_chance) continue
      const inner = await resolvePlaced(json.vegetation_feature)
      if (!inner) continue
      // waterlogged patches grow the vegetation in the water cell and waterlog it
      await generate(world, inner, rand, resolvePlaced, ox + dx, waterlogged ? topY : topY - dir, oz + dz)
      if (waterlogged) {
        const c = world.get(ox + dx, topY, oz + dz)
        if (c?.Properties?.waterlogged === "false") {
          world.set(ox + dx, topY, oz + dz, { Name: c.Name, Properties: { ...c.Properties, waterlogged: "true" } })
        }
      }
    }
  },

  async waterlogged_vegetation_patch(world, json, rand, resolvePlaced, ox, oy, oz) {
    return TYPES.vegetation_patch(world, json, rand, resolvePlaced, ox, oy, oz, true)
  },

  async random_selector(world, json, rand, resolvePlaced, ox, oy, oz) {
    for (const entry of json.features) {
      if (rand() < entry.chance) {
        const inner = await resolvePlaced(entry.feature)
        if (inner) return generate(world, inner, rand, resolvePlaced, ox, oy, oz)
      }
    }
    const inner = await resolvePlaced(json.default)
    if (inner) return generate(world, inner, rand, resolvePlaced, ox, oy, oz)
  },

  async weighted_random_selector(world, json, rand, resolvePlaced, ox, oy, oz) {
    const entry = pickWeighted(json.features ?? json.distribution, rand)
    const inner = await resolvePlaced(entry.data)
    if (inner) return generate(world, inner, rand, resolvePlaced, ox, oy, oz)
  },

  async simple_random_selector(world, json, rand, resolvePlaced, ox, oy, oz) {
    const list = json.features
    const pick = Array.isArray(list) ? list[nextInt(rand, list.length)] : list
    const inner = await resolvePlaced(pick)
    if (inner) return generate(world, inner, rand, resolvePlaced, ox, oy, oz)
  },

  async random_boolean_selector(world, json, rand, resolvePlaced, ox, oy, oz) {
    const inner = await resolvePlaced(rand() < 0.5 ? json.feature_true : json.feature_false)
    if (inner) return generate(world, inner, rand, resolvePlaced, ox, oy, oz)
  },

  async sequence(world, json, rand, resolvePlaced, ox, oy, oz) {
    for (const entry of json.features) {
      const pos = entry && typeof entry === "object"
        ? applyPlacement(world, entry.placement, rand, ox, oy, oz)
        : [ox, oy, oz]
      if (!pos) continue
      const inner = await resolvePlaced(entry)
      if (inner) await generate(world, inner, rand, resolvePlaced, ...pos)
    }
  },

  async huge_fungus(world, json, rand, resolvePlaced, ox, oy, oz) {
    let height = 4 + nextInt(rand, 10)
    if (nextInt(rand, 12) === 0) height *= 2
    const isHuge = !json.planted && rand() < 0.06
    const wart = strip(json.hat_state.Name) === "nether_wart_block"
    const stemRadius = isHuge ? 1 : 0
    for (let dx = -stemRadius; dx <= stemRadius; dx++) for (let dz = -stemRadius; dz <= stemRadius; dz++) {
      const corner = isHuge && Math.abs(dx) === stemRadius && Math.abs(dz) === stemRadius
      for (let dy = 0; dy < height; dy++) {
        if (world.get(ox + dx, oy + dy, oz + dz)) continue
        if (corner && rand() >= 0.1) continue
        world.set(ox + dx, oy + dy, oz + dz, json.stem_state)
      }
    }
    const hatHeight = Math.min(nextInt(rand, 1 + Math.floor(height / 3)) + 5, height)
    const hatStart = height - hatHeight
    for (let dy = hatStart; dy <= height; dy++) {
      let radius = dy < height - nextInt(rand, 3) ? 2 : 1
      if (hatHeight > 8 && dy < hatStart + 4) radius = 3
      if (isHuge) radius++
      for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
        const edgeX = dx === -radius || dx === radius
        const edgeZ = dz === -radius || dz === radius
        const inside = !edgeX && !edgeZ && dy !== height
        const corner = edgeX && edgeZ
        const bottom = dy < hatStart + 3
        const px = ox + dx, py = oy + dy, pz = oz + dz
        if (world.get(px, py, pz)) continue
        if (bottom) {
          if (inside) continue
          if (isHat(world.get(px, py - 1, pz), json)) world.set(px, py, pz, json.hat_state)
          else if (rand() < 0.15) {
            world.set(px, py, pz, json.hat_state)
            if (wart && nextInt(rand, 11) === 0) {
              let len = 1 + nextInt(rand, 5)
              if (nextInt(rand, 7) === 0) len *= 2
              weepingColumn(world, px, py - 1, pz, len, 23, 25, rand)
            }
          }
        } else {
          const [decorP, hatP, vineP] = inside ? [0.1, 0.2, wart ? 0.1 : 0]
            : corner ? [0.01, 0.7, wart ? 0.083 : 0]
            : [0.0005, 0.98, wart ? 0.07 : 0]
          if (rand() < decorP) world.set(px, py, pz, json.decor_state)
          else if (rand() < hatP) {
            world.set(px, py, pz, json.hat_state)
            if (rand() < vineP) {
              let len = 1 + nextInt(rand, 5)
              if (nextInt(rand, 7) === 0) len *= 2
              weepingColumn(world, px, py - 1, pz, len, 23, 25, rand)
            }
          }
        }
      }
    }
  },

  async weeping_vines(world, json, rand, resolvePlaced, ox, oy, oz) {
    world.set(ox, oy, oz, { Name: "minecraft:nether_wart_block" })
    const isRoof = (x, y, z) => strip(world.get(x, y, z)?.Name ?? "") === "nether_wart_block"
    for (let i = 0; i < 200; i++) {
      const px = ox + nextInt(rand, 6) - nextInt(rand, 6)
      const py = oy + nextInt(rand, 2) - nextInt(rand, 5)
      const pz = oz + nextInt(rand, 6) - nextInt(rand, 6)
      if (world.get(px, py, pz)) continue
      let neighbours = 0
      for (const [dx, dy, dz] of Object.values(DIR)) {
        if (isRoof(px + dx, py + dy, pz + dz)) neighbours++
        if (neighbours > 1) break
      }
      if (neighbours === 1) world.set(px, py, pz, { Name: "minecraft:nether_wart_block" })
    }
    for (let i = 0; i < 100; i++) {
      const px = ox + nextInt(rand, 8) - nextInt(rand, 8)
      const py = oy + nextInt(rand, 2) - nextInt(rand, 7)
      const pz = oz + nextInt(rand, 8) - nextInt(rand, 8)
      if (world.get(px, py, pz) || !isRoof(px, py + 1, pz)) continue
      let len = 1 + nextInt(rand, 8)
      if (nextInt(rand, 6) === 0) len *= 2
      if (nextInt(rand, 5) === 0) len = 1
      weepingColumn(world, px, py, pz, len, 17, 25, rand)
    }
  },

  async delta_feature(world, json, rand, resolvePlaced, ox, oy, oz) {
    const hasRim = rand() < 0.9
    const rimX = hasRim ? sampleInt(json.rim_size, rand) : 0
    const rimZ = hasRim ? sampleInt(json.rim_size, rand) : 0
    const rim = hasRim && rimX !== 0 && rimZ !== 0
    const rx = sampleInt(json.size, rand)
    const rz = sampleInt(json.size, rand)
    const limit = Math.max(rx, rz)
    for (let dx = -rx; dx <= rx; dx++) for (let dz = -rz; dz <= rz; dz++) {
      if (Math.abs(dx) + Math.abs(dz) > limit) continue
      if (rim) world.set(ox + dx, oy, oz + dz, json.rim)
      world.cells.set((ox + dx + rimX) + "," + oy + "," + (oz + dz + rimZ), json.contents)
    }
  },

  async netherrack_replace_blobs(world, json, rand, resolvePlaced, ox, oy, oz) {
    const rx = sampleInt(json.radius, rand), ry = sampleInt(json.radius, rand), rz = sampleInt(json.radius, rand)
    const limit = Math.max(rx, Math.max(ry, rz))
    for (let dx = -rx; dx <= rx; dx++) for (let dy = -ry; dy <= ry; dy++) for (let dz = -rz; dz <= rz; dz++) {
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > limit) continue
      world.set(ox + dx, oy + dy, oz + dz, json.state)
    }
  },

  async stepped_column_cluster(world, json, rand, resolvePlaced, ox, oy, oz) {
    const columnHeight = sampleInt(json.height, rand)
    const clusterReach = Math.min(columnHeight, sampleInt(json.cluster_reach, rand))
    const count = sampleInt(json.column_count, rand)
    for (let i = 0; i < count; i++) {
      const dx = nextInt(rand, clusterReach * 2 + 1) - clusterReach
      const dz = nextInt(rand, clusterReach * 2 + 1) - clusterReach
      const toPlace = columnHeight - (Math.abs(dx) + Math.abs(dz))
      if (toPlace < 0) continue
      const reach = sampleInt(json.column_reach, rand)
      for (let sx = -reach; sx <= reach; sx++) {
        for (let sz = -reach; sz <= reach; sz++) {
          let blocks = toPlace - Math.trunc((Math.abs(sx) + Math.abs(sz)) / 2)
          const x = ox + dx + sx, z = oz + dz + sz
          for (let y = oy; blocks >= 0; y++, blocks--) {
            if (!world.get(x, y, z)) world.set(x, y, z, sampleState(json.block, rand))
          }
        }
      }
    }
  },

  async end_island(world, json, rand, resolvePlaced, ox, oy, oz) {
    let size = nextInt(rand, 3) + 4
    for (let y = 0; size > 0.5; y--) {
      const r = Math.ceil(size)
      for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) {
        if (x * x + z * z <= (size + 1) * (size + 1)) world.set(ox + x, oy + y, oz + z, { Name: "minecraft:end_stone" })
      }
      size -= nextInt(rand, 2) + 0.5
    }
  },

  async spike(world, json, rand, resolvePlaced, ox, oy, oz) {
    let y0 = oy + nextInt(rand, 4)
    const height = nextInt(rand, 4) + 7
    const width = Math.floor(height / 4) + nextInt(rand, 2)
    if (width > 1 && nextInt(rand, 60) === 0) y0 += 10 + nextInt(rand, 30)
    for (let yo = 0; yo < height; yo++) {
      const scale = (1 - yo / height) * width
      const r = Math.ceil(scale)
      for (let xo = -r; xo <= r; xo++) {
        const fx = Math.abs(xo) - 0.25
        for (let zo = -r; zo <= r; zo++) {
          const fz = Math.abs(zo) - 0.25
          if (!(xo === 0 && zo === 0) && fx * fx + fz * fz > scale * scale) continue
          if ((xo === -r || xo === r || zo === -r || zo === r) && rand() > 0.75) continue
          if (!world.get(ox + xo, y0 + yo, oz + zo)) world.set(ox + xo, y0 + yo, oz + zo, json.state)
          if (yo !== 0 && r > 1) {
            const py = y0 - yo
            if (py >= oy && !world.get(ox + xo, py, oz + zo)) world.set(ox + xo, py, oz + zo, json.state)
          }
        }
      }
    }
    const pw = Math.max(0, Math.min(1, width - 1))
    for (let xo = -pw; xo <= pw; xo++) for (let zo = -pw; zo <= pw; zo++) {
      let py = y0 - 1
      let run = Math.abs(xo) === 1 && Math.abs(zo) === 1 ? nextInt(rand, 5) : 50
      while (py >= oy) {
        world.set(ox + xo, py, oz + zo, json.state)
        py--
        if (--run <= 0) {
          py -= nextInt(rand, 5) + 1
          run = nextInt(rand, 5)
        }
      }
    }
  },

  async chorus_plant(world, json, rand, resolvePlaced, ox, oy, oz) {
    const plant = new Set()
    const put = (x, y, z) => { plant.add(x + "," + y + "," + z); world.set(x, y, z, { Name: "minecraft:chorus_plant" }) }
    const empty = (x, y, z) => !world.get(x, y, z)
    const neighborsEmpty = (x, y, z, exceptDx, exceptDz) => {
      for (const n of HORIZ) {
        const dx = DIR[n][0], dz = DIR[n][2]
        if (dx === exceptDx && dz === exceptDz) continue
        if (!empty(x + dx, y, z + dz)) return false
      }
      return true
    }
    put(ox, oy, oz)
    const grow = (cx, cy, cz, depth) => {
      let height = nextInt(rand, 4) + 1
      if (depth === 0) height++
      for (let i = 0; i < height; i++) {
        if (!neighborsEmpty(cx, cy + i + 1, cz)) return
        put(cx, cy + i + 1, cz)
      }
      let branched = false
      if (depth < 4) {
        let stems = nextInt(rand, 4)
        if (depth === 0) stems++
        for (let i = 0; i < stems; i++) {
          const n = HORIZ[nextInt(rand, 4)]
          const dx = DIR[n][0], dz = DIR[n][2]
          const tx = cx + dx, ty = cy + height, tz = cz + dz
          if (Math.abs(tx - ox) < 8 && Math.abs(tz - oz) < 8 && empty(tx, ty, tz) && empty(tx, ty - 1, tz) && neighborsEmpty(tx, ty, tz, -dx, -dz)) {
            branched = true
            put(tx, ty, tz)
            grow(tx, ty, tz, depth + 1)
          }
        }
      }
      if (!branched) world.set(cx, cy + height, cz, { Name: "minecraft:chorus_flower", Properties: { age: "5" } })
    }
    grow(ox, oy, oz, 0)
    for (const key of plant) {
      const [x, y, z] = key.split(",").map(Number)
      const link = (dx, dy, dz) => {
        const c = world.get(x + dx, y + dy, z + dz)
        return String(!!c && /(^|:)(chorus_plant|chorus_flower)$/.test(c.Name))
      }
      world.set(x, y, z, { Name: "minecraft:chorus_plant", Properties: {
        north: link(0, 0, -1), south: link(0, 0, 1), west: link(-1, 0, 0), east: link(1, 0, 0),
        up: link(0, 1, 0), down: y === oy ? "true" : link(0, -1, 0)
      } })
    }
  },

  async geode(world, json, rand, resolvePlaced, ox, oy, oz) {
    // the dump omits codec-default fields, so absent means vanilla's default
    const points = []
    const numPoints = sampleInt(json.distribution_points ?? { type: "minecraft:uniform", min_inclusive: 3, max_inclusive: 4 }, rand)
    const pointOffset = json.point_offset ?? { type: "minecraft:uniform", min_inclusive: 1, max_inclusive: 2 }
    const crackPoints = []
    const crackAdjust = numPoints / (json.outer_wall_distance?.max_inclusive ?? 4)
    const layers = json.layers ?? {}
    const innerAir = 1 / Math.sqrt(layers.filling ?? 1.7)
    const innermost = 1 / Math.sqrt((layers.inner_layer ?? 2.2) + crackAdjust)
    const innerCrust = 1 / Math.sqrt((layers.middle_layer ?? 3.2) + crackAdjust)
    const outerCrust = 1 / Math.sqrt((layers.outer_layer ?? 4.2) + crackAdjust)
    const crack = json.crack ?? {}
    const crackSize = 1 / Math.sqrt((crack.base_crack_size ?? 2) + rand() / 2 + (numPoints > 3 ? crackAdjust : 0))
    const hasCrack = rand() < (crack.generate_crack_chance ?? 1)
    const wall = json.outer_wall_distance ?? { type: "minecraft:uniform", min_inclusive: 4, max_inclusive: 6 }
    for (let i = 0; i < numPoints; i++) {
      points.push([
        ox + sampleInt(wall, rand),
        oy + sampleInt(wall, rand),
        oz + sampleInt(wall, rand),
        sampleInt(pointOffset, rand)
      ])
    }
    if (hasCrack) {
      const side = nextInt(rand, 4)
      const off = numPoints * 2 + 1
      const [cx, cz] = side === 0 ? [off, 0] : side === 1 ? [0, off] : side === 2 ? [off, off] : [0, 0]
      for (const cy of [7, 5, 1]) crackPoints.push([ox + cx, oy + cy, oz + cz])
    }
    const blocks = json.blocks ?? {}
    const potential = []
    const lo = json.min_gen_offset ?? -16, hi = json.max_gen_offset ?? 16
    for (let x = lo; x <= hi; x++) for (let y = lo; y <= hi; y++) for (let z = lo; z <= hi; z++) {
      const px = ox + x, py = oy + y, pz = oz + z
      let sum = 0
      for (const [qx, qy, qz, qo] of points) {
        const d = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2 + qo
        sum += 1 / Math.sqrt(Math.max(d, 1e-6))
      }
      if (sum < outerCrust) continue
      if (sum >= innerAir) {
        const filling = sampleState(blocks.filling_provider, rand)
        if (filling && strip(filling.Name) !== "air") world.set(px, py, pz, filling)
        continue
      }
      let crackSum = 0
      for (const [qx, qy, qz] of crackPoints) {
        const d = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2 + (crack.crack_point_offset ?? 2)
        crackSum += 1 / Math.sqrt(Math.max(d, 1e-6))
      }
      if (hasCrack && crackSum >= crackSize) continue
      if (sum >= innermost) {
        const alternate = rand() < (json.use_alternate_layer0_chance ?? 0)
        world.set(px, py, pz, sampleState(alternate ? blocks.alternate_inner_layer_provider : blocks.inner_layer_provider, rand))
        if ((!(json.placements_require_layer0_alternate ?? true) || alternate) && rand() < (json.use_potential_placements_chance ?? 0.35)) {
          potential.push([px, py, pz])
        }
      } else if (sum >= innerCrust) {
        world.set(px, py, pz, sampleState(blocks.middle_layer_provider, rand))
      } else {
        world.set(px, py, pz, sampleState(blocks.outer_layer_provider, rand))
      }
    }
    const placements = blocks.inner_placements ?? []
    for (const [px, py, pz] of potential) {
      const state = placements[nextInt(rand, placements.length)]
      if (!state) continue
      for (const name of ["down", "up", "north", "south", "west", "east"]) {
        const [dx, dy, dz] = DIR[name]
        const tx = px + dx, ty = py + dy, tz = pz + dz
        if (world.get(tx, ty, tz)) continue
        const props = { ...(state.Properties ?? {}) }
        if ("facing" in props) props.facing = name
        world.set(tx, ty, tz, { Name: state.Name, Properties: props })
        break
      }
    }
  }
}

// ---- adapted where the game needs terrain context the empty world can't provide

Object.assign(TYPES, {
  async no_op() {},

  async overlay(world, json, rand, resolvePlaced, ox, oy, oz) {
    for (const entry of json.features) {
      const pos = entry && typeof entry === "object"
        ? applyPlacement(world, entry.placement, rand, ox, oy, oz)
        : [ox, oy, oz]
      if (!pos) continue
      const inner = await resolvePlaced(entry)
      if (inner) await generate(world, inner, rand, resolvePlaced, ...pos)
    }
  },

  async projected_random_patchy_square(world, json, rand, resolvePlaced, ox, oy, oz) {
    const size = sampleInt(json.size, rand)
    const bound = size * size + 1
    for (let dx = -size; dx <= size; dx++) for (let dz = -size; dz <= size; dz++) {
      if (nextInt(rand, bound) >= bound - Math.abs(dx) * Math.abs(dz)) continue
      let x = ox + dx, y = oy, z = oz + dz
      let drop = json.max_projection_height
      while (!world.get(x, y - 1, z)) {
        y--
        if (--drop <= 0) break
      }
      const state = contextualState(world, json.block, rand, x, y, z)
      if (state && !world.get(x, y, z)) world.set(x, y, z, state)
    }
  },

  async single_block_pillar(world, json, rand, resolvePlaced, ox, oy, oz) {
    const dy = strip(json.direction) === "down" ? -1 : 1
    const chance = json.chance_to_continue ?? 1
    const cap = chance >= 1 ? 8 + nextInt(rand, 9) : 64
    let y = oy
    for (let i = 0; i < cap; i++) {
      if (world.get(ox, y, oz) || (i > 0 && rand() >= chance)) break
      world.set(ox, y, oz, sampleState(json.block, rand))
      y += dy
    }
    y -= dy
    if (json.cap_feature) {
      const inner = await resolvePlaced(json.cap_feature)
      if (inner) await generate(world, inner, rand, resolvePlaced, ox, y, oz)
    }
  },

  async speleothem(world, json, rand, resolvePlaced, ox, oy, oz) {
    const dirs = Object.keys(DIR)
    const spread = (x, y, z) => {
      if (!world.get(x, y, z)) world.set(x, y, z, json.base_block)
    }
    world.set(ox, oy - 1, oz, json.base_block)
    for (const n of HORIZ) {
      if (rand() > (json.chance_of_directional_spread ?? 0.7)) continue
      const x1 = ox + DIR[n][0], y1 = oy - 1, z1 = oz + DIR[n][2]
      spread(x1, y1, z1)
      if (rand() > (json.chance_of_spread_radius2 ?? 0.5)) continue
      const m = DIR[dirs[nextInt(rand, dirs.length)]]
      const x2 = x1 + m[0], y2 = y1 + m[1], z2 = z1 + m[2]
      spread(x2, y2, z2)
      if (rand() > (json.chance_of_spread_radius3 ?? 0.5)) continue
      const k = DIR[dirs[nextInt(rand, dirs.length)]]
      spread(x2 + k[0], y2 + k[1], z2 + k[2])
    }
    const tall = rand() < (json.chance_of_taller_generation ?? 0.2)
    const tip = json.pointed_block
    if (tall) {
      world.set(ox, oy, oz, { Name: tip.Name, Properties: { ...(tip.Properties ?? {}), thickness: "frustum" } })
      world.set(ox, oy + 1, oz, tip)
    } else {
      world.set(ox, oy, oz, tip)
    }
  },

  // synthesized cave like large_dripstone: grid floor, virtual ceiling 7..10 up
  async speleothem_cluster(world, json, rand, resolvePlaced, ox, oy, oz) {
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9))) * Math.cos(2 * Math.PI * rand())
    const clampedMap = (v, a, b, from, to) => v <= a ? from : v >= b ? to : from + (to - from) * (v - a) / (b - a)
    const height = sampleInt(json.height, rand)
    const wetness = sampleFloat(json.wetness, rand)
    const density = sampleFloat(json.density, rand)
    const rx = sampleInt(json.radius, rand), rz = sampleInt(json.radius, rand)
    const ceilY = oy + 7 + nextInt(rand, 4)
    const speleoHeight = (dx, dz, maxH) => {
      if (rand() > density) return 0
      const mean = clampedMap(Math.abs(dx) + Math.abs(dz), 0, json.max_distance_from_center_affecting_height_bias, maxH / 2, 0)
      return Math.trunc(Math.min(maxH, Math.max(0, mean + gauss() * json.height_deviation)))
    }
    const isWater = (x, y, z) => strip(world.get(x, y, z)?.Name ?? "") === "water"
    const poolOk = (x, y, z) => {
      if (world.get(x, y, z)) return false
      for (const n of HORIZ) {
        const c = world.get(x + DIR[n][0], y, z + DIR[n][2])
        if (c && strip(c.Name) !== "water") return false
      }
      return !world.get(x, y - 1, z)
    }
    const grow = (x, z, startY, dir, len, merged) => {
      const states = []
      if (len >= 3) {
        states.push("base")
        for (let i = 0; i < len - 3; i++) states.push("middle")
      }
      if (len >= 2) states.push("frustum")
      if (len >= 1) states.push(merged ? "tip_merge" : "tip")
      let y = startY
      for (const thickness of states) {
        const waterlogged = isWater(x, y, z) ? "true" : "false"
        world.set(x, y, z, { Name: json.pointed_block.Name, Properties: { ...(json.pointed_block.Properties ?? {}), vertical_direction: dir === 1 ? "up" : "down", thickness, waterlogged } })
        y += dir
      }
    }
    for (let dx = -rx; dx <= rx; dx++) {
      for (let dz = -rz; dz <= rz; dz++) {
        const x = ox + dx, z = oz + dz
        const chance = clampedMap(Math.min(rx - Math.abs(dx), rz - Math.abs(dz)), 0,
          json.max_distance_from_edge_affecting_chance_of_speleothem, json.chance_of_speleothem_at_max_distance_from_center, 1)
        let floorY = oy - 1
        if (rand() < wetness && poolOk(x, floorY, z)) {
          world.set(x, floorY, z, { Name: "minecraft:water", Properties: { level: "0" } })
          floorY--
        }
        let stalac = 0
        if (rand() < chance) {
          const thick = sampleInt(json.speleothem_block_layer_thickness, rand)
          for (let i = 0; i < thick && !world.get(x, ceilY + i, z); i++) {
            world.set(x, ceilY + i, z, json.base_block)
          }
          stalac = speleoHeight(dx, dz, Math.min(height, ceilY - floorY))
        }
        let stalag = 0
        if (rand() < chance) {
          const thick = sampleInt(json.speleothem_block_layer_thickness, rand)
          for (let i = 0; i < thick && !world.get(x, floorY - i, z); i++) {
            world.set(x, floorY - i, z, json.base_block)
          }
          const d = json.max_stalagmite_stalactite_height_diff ?? 0
          stalag = Math.max(0, stalac + nextInt(rand, 2 * d + 1) - d)
        }
        let aStalac = stalac, aStalag = stalag
        if (ceilY - stalac <= floorY + stalag) {
          const low = Math.max(ceilY - stalac, floorY + 1)
          const high = Math.min(floorY + stalag, ceilY - 1)
          const bottom = low + nextInt(rand, high + 2 - low)
          aStalac = ceilY - bottom
          aStalag = bottom - 1 - floorY
        }
        const coin = rand() < 0.5
        const merged = coin && aStalac > 0 && aStalag > 0 && aStalac + aStalag === ceilY - floorY - 1
        grow(x, z, ceilY - 1, -1, aStalac, merged)
        grow(x, z, floorY + 1, 1, aStalag, merged)
      }
    }
  },

  async large_dripstone(world, json, rand, resolvePlaced, ox, oy, oz) {
    const caveHeight = 4 + nextInt(rand, 57)
    const floorY = oy, ceilY = oy + caveHeight - 1
    const originMin = Math.max(floorY, ceilY - 30), originMax = Math.min(ceilY, floorY + 30)
    const originY = originMin + nextInt(rand, originMax - originMin + 1)
    const [rMin, rMaxProvider] = intBounds(json.column_radius)
    const ratio = json.max_column_radius_to_cave_height_ratio
    const rMax = Math.min(Math.max(Math.trunc(caveHeight * ratio), rMin), rMaxProvider)
    const radius = rMin + nextInt(rand, rMax - rMin + 1)
    const stalactite = { rootY: ceilY, dir: -1, radius, bluntness: sampleFloat(json.stalactite_bluntness, rand), scale: sampleFloat(json.height_scale, rand) }
    const stalagmite = { rootY: floorY, dir: 1, radius, bluntness: sampleFloat(json.stalagmite_bluntness, rand), scale: sampleFloat(json.height_scale, rand) }
    const suitable = s => s.radius >= json.min_radius_for_wind && s.bluntness >= json.min_bluntness_for_wind
    let wind = null
    if (suitable(stalactite) && suitable(stalagmite)) {
      const speed = sampleFloat(json.wind_speed, rand)
      const angle = rand() * Math.PI
      wind = { x: Math.cos(angle) * speed, z: Math.sin(angle) * speed, max: 16 - radius }
    }
    const windAt = y => {
      if (!wind) return [0, 0]
      const dy = originY - y
      return [
        Math.min(wind.max, Math.max(-wind.max, Math.floor(wind.x * dy))),
        Math.min(wind.max, Math.max(-wind.max, Math.floor(wind.z * dy)))
      ]
    }
    const heightAt = (dist, s) => {
      const d = Math.max(dist, s.bluntness) / s.radius * 0.384
      const h = Math.max(s.scale * (0.75 * Math.pow(d, 4 / 3) - Math.pow(d, 2 / 3) - Math.log(d) / 3), 0)
      return Math.trunc(h / 0.384 * s.radius)
    }
    const place = s => {
      const rootY = s.rootY - s.dir
      for (let dx = -s.radius; dx <= s.radius; dx++) {
        for (let dz = -s.radius; dz <= s.radius; dz++) {
          const dist = Math.sqrt(dx * dx + dz * dz)
          if (dist > s.radius) continue
          let h = heightAt(dist, s)
          if (h <= 0) continue
          if (rand() < 0.2) h = Math.trunc(h * (0.8 + rand() * 0.2))
          for (let i = 0; i < h; i++) {
            const y = rootY + i * s.dir
            if (y < floorY || y > ceilY) continue
            const [wx, wz] = windAt(y)
            world.set(ox + dx + wx, y, oz + dz + wz, { Name: "minecraft:dripstone_block" })
          }
        }
      }
    }
    place(stalactite)
    place(stalagmite)
  },

  async block_blob(world, json, rand, resolvePlaced, ox, oy, oz) {
    let cx = ox, cy = oy, cz = oz
    for (let c = 0; c < 3; c++) {
      const xr = nextInt(rand, 2), yr = nextInt(rand, 2), zr = nextInt(rand, 2)
      const tr = (xr + yr + zr) * 0.333 + 0.5
      for (let dx = -xr; dx <= xr; dx++) for (let dy = -yr; dy <= yr; dy++) for (let dz = -zr; dz <= zr; dz++) {
        if (dx * dx + dy * dy + dz * dz > tr * tr) continue
        if (cy + dy >= oy - 1) world.set(cx + dx, cy + dy, cz + dz, json.state)
      }
      cx += -1 + nextInt(rand, 2)
      cy += -nextInt(rand, 2)
      cz += -1 + nextInt(rand, 2)
    }
  },

  async blue_ice(world, json, rand, resolvePlaced, ox, oy, oz) {
    world.set(ox, oy, oz, { Name: "minecraft:blue_ice" })
    for (let i = 0; i < 200; i++) {
      const dy = nextInt(rand, 5) - nextInt(rand, 6)
      let spread = 3
      if (dy < 2) spread += Math.trunc(dy / 2)
      if (spread < 1) continue
      const px = ox + nextInt(rand, spread) - nextInt(rand, spread)
      const py = oy + dy
      const pz = oz + nextInt(rand, spread) - nextInt(rand, spread)
      if (world.get(px, py, pz)) continue
      for (const [dx2, dy2, dz2] of Object.values(DIR)) {
        if (strip(world.get(px + dx2, py + dy2, pz + dz2)?.Name ?? "") === "blue_ice") {
          world.set(px, py, pz, { Name: "minecraft:blue_ice" })
          break
        }
      }
    }
  },

  // the grid is the waterline; the keel hangs below it (no ocean to sit in)
  async iceberg(world, json, rand, resolvePlaced, ox, oy, oz) {
    const ICE = ["packed_ice", "snow_block", "blue_ice"]
    const snowOnTop = rand() > 0.7
    const shapeAngle = rand() * 2 * Math.PI
    const ellipseA = 11 - nextInt(rand, 5)
    const ellipseCBase = 3 + nextInt(rand, 3)
    const isEllipse = rand() > 0.7
    let overH = isEllipse ? nextInt(rand, 6) + 6 : nextInt(rand, 15) + 3
    if (!isEllipse && rand() > 0.9) overH += nextInt(rand, 19) + 7
    const underH = Math.min(overH + nextInt(rand, 11), 18)
    const width = Math.min(overH + nextInt(rand, 7) - nextInt(rand, 5), 11)
    const a0 = isEllipse ? ellipseA : 11
    const ellipseC = (yOff, h) => {
      let c = ellipseCBase
      if (yOff > 0 && h - yOff <= 3) c -= 4 - (h - yOff)
      return c
    }
    const sdEllipse = (xo, zo, cx, cz, a, c, angle) =>
      Math.pow(((xo - cx) * Math.cos(angle) - (zo - cz) * Math.sin(angle)) / a, 2) +
      Math.pow(((xo - cx) * Math.sin(angle) + (zo - cz) * Math.cos(angle)) / c, 2) - 1
    const sdCircle = (xo, zo, radius) => 10 * Math.min(0.8, Math.max(0.2, rand())) / radius + xo * xo + zo * zo - radius * radius
    // | 0 kills negative zero: Math.ceil(-0.3) is -0 in js, and 10 / -0 is
    // -Infinity where java's int 0 gives +Infinity
    const rRound = (yOff, h) => {
      const k = 3.5 - rand()
      let scale = (1 - yOff * yOff / (h * k)) * width
      if (h > 15 + nextInt(rand, 5)) {
        const t = yOff < 3 + nextInt(rand, 6) ? Math.trunc(yOff / 2) : yOff
        scale = (1 - t / (h * k * 0.4)) * width
      }
      return Math.ceil(scale / 2) | 0
    }
    const rEllipse = (yOff, h) => Math.ceil((1 - yOff * yOff / h) * width / 2) | 0
    const rSteep = (yOff, h) => Math.ceil((1 - yOff / (h * (1 + rand() / 2))) * width / 2) | 0
    const setBerg = (x, y, z, hDiff, h) => {
      const c = world.get(x, y, z)
      if (c && !["snow_block", "ice"].includes(strip(c.Name))) return
      const randomness = !isEllipse || rand() > 0.05
      const divisor = isEllipse ? 3 : 2
      if (snowOnTop && hDiff <= nextInt(rand, Math.max(1, Math.trunc(h / divisor))) + h * 0.6 && randomness) {
        world.set(x, y, z, { Name: "minecraft:snow_block" })
      } else {
        world.set(x, y, z, json.state)
      }
    }
    const genBlock = (xo, yOff, zo, radius, a, h) => {
      const sd = isEllipse ? sdEllipse(xo, zo, 0, 0, a, ellipseC(yOff, h), shapeAngle) : sdCircle(xo, zo, radius)
      if (sd >= 0) return
      const compareVal = isEllipse ? -0.5 : -6 - nextInt(rand, 3)
      if (sd > compareVal && rand() > 0.9) return
      setBerg(ox + xo, oy + yOff, oz + zo, h - yOff, h)
    }
    for (let xo = -a0; xo < a0; xo++) {
      for (let zo = -a0; zo < a0; zo++) {
        for (let yOff = 0; yOff < overH; yOff++) {
          const radius = isEllipse ? rEllipse(yOff, overH) : rRound(yOff, overH)
          if (isEllipse || xo < radius) genBlock(xo, yOff, zo, radius, a0, overH)
        }
      }
    }
    const aS = isEllipse ? ellipseA : Math.trunc(width / 2)
    for (let x = -aS; x <= aS; x++) {
      for (let z = -aS; z <= aS; z++) {
        for (let yOff = 0; yOff <= overH; yOff++) {
          const px = ox + x, py = oy + yOff, pz = oz + z
          const cell = world.get(px, py, pz)
          if (!cell || !ICE.includes(strip(cell.Name))) continue
          if (py - 1 >= oy && !world.get(px, py - 1, pz)) {
            world.remove(px, py, pz)
            world.remove(px, py + 1, pz)
          } else {
            let exposed = 0
            for (const n of HORIZ) {
              if (!ICE.includes(strip(world.get(px + DIR[n][0], py, pz + DIR[n][2])?.Name ?? ""))) exposed++
            }
            if (exposed >= 3) world.remove(px, py, pz)
          }
        }
      }
    }
    for (let xo = -a0; xo < a0; xo++) {
      for (let zo = -a0; zo < a0; zo++) {
        for (let yOff = -1; yOff > -underH; yOff--) {
          const newA = isEllipse ? Math.ceil(a0 * (1 - yOff * yOff / (underH * 8))) : a0
          const radius = rSteep(-yOff, underH)
          if (xo < radius) genBlock(xo, yOff, zo, radius, newA, underH)
        }
      }
    }
    if (isEllipse ? rand() > 0.1 : rand() > 0.7) {
      const carve = (radius, yOff, angle, lx, lz) => {
        const a = radius + 1 + Math.trunc(ellipseA / 3)
        const c = Math.min(radius - 3, 3) + Math.trunc(ellipseCBase / 2) - 1
        for (let xo = -a; xo < a; xo++) {
          for (let zo = -a; zo < a; zo++) {
            if (sdEllipse(xo, zo, lx, lz, a, c, angle) >= 0) continue
            const px = ox + xo, py = oy + yOff, pz = oz + zo
            if (ICE.includes(strip(world.get(px, py, pz)?.Name ?? ""))) world.remove(px, py, pz)
          }
        }
      }
      const signX = rand() < 0.5 ? -1 : 1
      const signZ = rand() < 0.5 ? -1 : 1
      const half = Math.trunc(width / 2)
      let xOff = nextInt(rand, Math.max(half - 2, 1))
      if (rand() < 0.5) xOff = half + 1 - nextInt(rand, Math.max(width - half - 1, 1))
      let zOff = nextInt(rand, Math.max(half - 2, 1))
      if (rand() < 0.5) zOff = half + 1 - nextInt(rand, Math.max(width - half - 1, 1))
      if (isEllipse) xOff = zOff = nextInt(rand, Math.max(ellipseA - 5, 1))
      const lx = signX * xOff, lz = signZ * zOff
      const angle = isEllipse ? shapeAngle + Math.PI / 2 : rand() * 2 * Math.PI
      for (let yOff = 0; yOff < overH - 3; yOff++) {
        carve(rRound(yOff, overH), yOff, angle, lx, lz)
      }
      for (let yOff = -1; yOff > -overH + nextInt(rand, 5); yOff--) {
        carve(rSteep(-yOff, overH), yOff, angle, lx, lz)
      }
    }
  },

  async lake(world, json, rand, resolvePlaced, ox, oy, oz) {
    const grid = new Uint8Array(16 * 16 * 8)
    const at = (x, y, z) => (x * 16 + z) * 8 + y
    const spots = nextInt(rand, 4) + 4
    for (let i = 0; i < spots; i++) {
      const xr = rand() * 6 + 3, yr = rand() * 4 + 2, zr = rand() * 6 + 3
      const xp = rand() * (16 - xr - 2) + 1 + xr / 2
      const yp = rand() * (8 - yr - 4) + 2 + yr / 2
      const zp = rand() * (16 - zr - 2) + 1 + zr / 2
      for (let x = 1; x < 15; x++) for (let z = 1; z < 15; z++) for (let y = 1; y < 7; y++) {
        const xd = (x - xp) / (xr / 2), yd = (y - yp) / (yr / 2), zd = (z - zp) / (zr / 2)
        if (xd * xd + yd * yd + zd * zd < 1) grid[at(x, y, z)] = 1
      }
    }
    const fluid = sampleState(json.fluid, rand)
    const barrier = sampleState(json.barrier, rand)
    const boundary = (x, y, z) => !grid[at(x, y, z)] && (
      (x < 15 && grid[at(x + 1, y, z)]) || (x > 0 && grid[at(x - 1, y, z)]) ||
      (z < 15 && grid[at(x, y, z + 1)]) || (z > 0 && grid[at(x, y, z - 1)]) ||
      (y < 7 && grid[at(x, y + 1, z)]) || (y > 0 && grid[at(x, y - 1, z)])
    )
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 8; y++) {
      const px = ox + x - 8, py = oy + y - 4, pz = oz + z - 8
      if (grid[at(x, y, z)]) {
        if (y < 4) world.set(px, py, pz, fluid)
      } else if (boundary(x, y, z) && barrier && strip(barrier.Name) !== "air" && y < 4) {
        world.set(px, py, pz, barrier)
      }
    }
  },

  async monster_room(world, json, rand, resolvePlaced, ox, oy, oz) {
    const xr = nextInt(rand, 2) + 2, zr = nextInt(rand, 2) + 2
    for (let dx = -xr - 1; dx <= xr + 1; dx++) for (let dz = -zr - 1; dz <= zr + 1; dz++) {
      for (let dy = -1; dy <= 4; dy++) {
        const edge = dx === -xr - 1 || dx === xr + 1 || dz === -zr - 1 || dz === zr + 1 || dy === -1 || dy === 4
        if (!edge) continue
        const state = dy === -1 && nextInt(rand, 4) !== 0
          ? { Name: "minecraft:mossy_cobblestone" }
          : { Name: "minecraft:cobblestone" }
        world.set(ox + dx, oy + dy, oz + dz, state)
      }
    }
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < 3; i++) {
        const cx = ox + nextInt(rand, xr * 2 + 1) - xr
        const cz = oz + nextInt(rand, zr * 2 + 1) - zr
        if (world.get(cx, oy, cz)) continue
        let walls = 0, facing = "north"
        for (const n of HORIZ) {
          if (world.get(cx + DIR[n][0], oy, cz + DIR[n][2])) {
            walls++
            facing = OPP[n]
          }
        }
        if (walls === 1) {
          world.set(cx, oy, cz, { Name: "minecraft:chest", Properties: { facing, type: "single", waterlogged: "false" } })
          break
        }
      }
    }
    world.set(ox, oy, oz, { Name: "minecraft:spawner" })
  },

  async desert_well(world, json, rand, resolvePlaced, ox, oy, oz) {
    const SANDSTONE = { Name: "minecraft:sandstone" }
    const SLAB = { Name: "minecraft:sandstone_slab", Properties: { type: "bottom", waterlogged: "false" } }
    const WATER = { Name: "minecraft:water", Properties: { level: "0" } }
    for (let dy = -2; dy <= 0; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      world.set(ox + dx, oy + dy, oz + dz, SANDSTONE)
    }
    world.set(ox, oy, oz, WATER)
    for (const n of HORIZ) world.set(ox + DIR[n][0], oy, oz + DIR[n][2], WATER)
    world.set(ox, oy - 1, oz, { Name: "minecraft:sand" })
    for (const n of HORIZ) world.set(ox + DIR[n][0], oy - 1, oz + DIR[n][2], { Name: "minecraft:sand" })
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (dx === -2 || dx === 2 || dz === -2 || dz === 2) world.set(ox + dx, oy + 1, oz + dz, SANDSTONE)
    }
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) world.set(ox + dx, oy + 1, oz + dz, SLAB)
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      world.set(ox + dx, oy + 4, oz + dz, dx === 0 && dz === 0 ? SANDSTONE : SLAB)
    }
    for (let dy = 1; dy <= 3; dy++) for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      world.set(ox + dx, oy + dy, oz + dz, SANDSTONE)
    }
    const spots = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]
    for (const depth of [1, 2]) {
      const [dx, dz] = spots[nextInt(rand, spots.length)]
      world.set(ox + dx, oy - depth, oz + dz, { Name: "minecraft:suspicious_sand", Properties: { dusted: "0" } })
    }
  },

  async end_gateway(world, json, rand, resolvePlaced, ox, oy, oz) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) {
      const sameX = dx === 0, sameY = dy === 0, sameZ = dz === 0
      const end = Math.abs(dy) === 2
      if (sameX && sameY && sameZ) world.set(ox, oy, oz, { Name: "minecraft:end_gateway" })
      else if (sameY) continue
      else if (end && sameX && sameZ) world.set(ox + dx, oy + dy, oz + dz, { Name: "minecraft:bedrock" })
      else if ((sameX || sameZ) && !end) world.set(ox + dx, oy + dy, oz + dz, { Name: "minecraft:bedrock" })
    }
  },

  async end_podium(world, json, rand, resolvePlaced, ox, oy, oz) {
    const BEDROCK = { Name: "minecraft:bedrock" }
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > 4.5) continue
      if (dist > 3.5) { world.set(ox + dx, oy - 1, oz + dz, BEDROCK); continue }
      if (Math.abs(dx) < 2 && Math.abs(dz) < 2 && !(dx === 0 && dz === 0)) {
        world.set(ox + dx, oy - 1, oz + dz, json.active ? { Name: "minecraft:end_portal" } : BEDROCK)
      } else if (!(dx === 0 && dz === 0)) {
        world.set(ox + dx, oy - 1, oz + dz, BEDROCK)
      }
    }
    for (let dy = -1; dy <= 2; dy++) world.set(ox, oy + dy, oz, BEDROCK)
    for (const n of HORIZ) {
      world.set(ox + DIR[n][0], oy + 2, oz + DIR[n][2], { Name: "minecraft:wall_torch", Properties: { facing: n } })
    }
    if (json.active) world.set(ox, oy + 3, oz, { Name: "minecraft:dragon_egg" })
  },

  async end_platform(world, json, rand, resolvePlaced, ox, oy, oz) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      world.set(ox + dx, oy - 1, oz + dz, { Name: "minecraft:obsidian" })
    }
  },

  async end_spike(world, json, rand, resolvePlaced, ox, oy, oz) {
    const { structure } = await runEndSpike(null, { seed: nextInt(rand, 0x7fffffff) })
    const a = structure.anchor ?? [0, 0, 0]
    for (const b of structure.blocks) {
      const e = structure.palette[b.state]
      world.set(ox + b.pos[0] - a[0], oy + b.pos[1], oz + b.pos[2] - a[2], e)
    }
  },

  async void_start_platform(world, json, rand, resolvePlaced, ox, oy, oz) {
    for (let dx = -16; dx <= 16; dx++) for (let dz = -16; dz <= 16; dz++) {
      world.set(ox + dx, oy - 1, oz + dz, dx === 0 && dz === 0 ? { Name: "minecraft:cobblestone" } : { Name: "minecraft:stone" })
    }
  },

  async bonus_chest(world, json, rand, resolvePlaced, ox, oy, oz) {
    world.set(ox, oy, oz, { Name: "minecraft:chest", Properties: { facing: "north", type: "single", waterlogged: "false" } })
    for (const n of HORIZ) {
      world.set(ox + DIR[n][0], oy, oz + DIR[n][2], { Name: "minecraft:torch" })
    }
  },

  // wall-mounted adaptations face north so the interesting side greets the default camera
  async spring_feature(world, json, rand, resolvePlaced, ox, oy, oz) {
    const rock = { Name: [json.valid_blocks ?? "minecraft:stone"].flat()[0] }
    world.set(ox, oy + 1, oz, rock)
    world.set(ox, oy - 1, oz, rock)
    world.set(ox - 1, oy, oz, rock)
    world.set(ox + 1, oy, oz, rock)
    world.set(ox, oy, oz + 1, rock)
    const fluid = json.state?.Name ?? "minecraft:water"
    world.set(ox, oy, oz, { Name: fluid, Properties: { level: "0" } })
  },

  async vines(world, json, rand, resolvePlaced, ox, oy, oz) {
    for (let dy = 0; dy < 3; dy++) world.set(ox, oy + dy, oz + 1, { Name: "minecraft:stone" })
    for (let dy = 0; dy < 3; dy++) world.set(ox, oy + dy, oz, { Name: "minecraft:vine", Properties: { south: "true" } })
  },

  async multiface_growth(world, json, rand, resolvePlaced, ox, oy, oz) {
    const host = { Name: [json.can_be_placed_on ?? "minecraft:stone"].flat()[0] }
    const block = json.block ?? "minecraft:glow_lichen"
    for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy < 3; dy++) {
      world.set(ox + dx, oy + dy, oz + 1, host)
    }
    for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy < 3; dy++) {
      if (rand() < 0.6) world.set(ox + dx, oy + dy, oz, { Name: block, Properties: { south: "true" } })
    }
  },

  async random_neighbor_spread(world, json, rand, resolvePlaced, ox, oy, oz) {
    const accepted = strip(typeof json.accepted_neighbors === "string" ? json.accepted_neighbors : json.accepted_neighbors?.[0] ?? "")
    world.set(ox, oy, oz, sampleState(json.block, rand))
    const attempts = sampleInt(json.attempts, rand)
    for (let i = 0; i < attempts; i++) {
      const px = ox + sampleInt(json.xz_offset, rand)
      const py = oy + sampleInt(json.y_offset, rand)
      const pz = oz + sampleInt(json.xz_offset, rand)
      if (world.get(px, py, pz)) continue
      let neighbours = 0
      for (const [dx, dy, dz] of Object.values(DIR)) {
        if (strip(world.get(px + dx, py + dy, pz + dz)?.Name ?? "") === accepted) neighbours++
        if (neighbours > 1) break
      }
      if (neighbours === 1) world.set(px, py, pz, sampleState(json.block, rand))
    }
  },

  async underwater_magma(world, json, rand, resolvePlaced, ox, oy, oz) {
    const r = json.placement_radius_around_floor ?? 1
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (rand() < (json.placement_probability_per_valid_position ?? 0.5)) {
        world.set(ox + dx, oy, oz + dz, { Name: "minecraft:magma_block" })
      }
    }
  },

  async freeze_top_layer(world, json, rand, resolvePlaced, ox, oy, oz) {
    world.set(ox, oy, oz, { Name: "minecraft:snow", Properties: { layers: "1" } })
  },

  async sculk_patch(world, json, rand, resolvePlaced, ox, oy, oz) {
    const r = 2 + Math.min(2, Math.floor((json.charge_count ?? 8) / 5))
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r + rand() * 2) continue
      world.set(ox + dx, oy - 1, oz + dz, { Name: "minecraft:sculk" })
      if (rand() < 0.12) {
        world.set(ox + dx, oy, oz + dz, { Name: "minecraft:sculk_vein", Properties: { down: "true" } })
      }
    }
    if (rand() < (json.catalyst_chance ?? 0)) world.set(ox, oy, oz, { Name: "minecraft:sculk_catalyst", Properties: { bloom: "false" } })
    const growths = sampleInt(json.extra_rare_growths, rand)
    for (let i = 0; i < growths; i++) {
      world.set(ox + nextInt(rand, 5) - 2, oy, oz + nextInt(rand, 5) - 2, { Name: "minecraft:sculk_shrieker", Properties: { can_summon: "true", shrieking: "false", waterlogged: "false" } })
    }
    if ((json.growth_rounds ?? 0) > 0 || rand() < 0.5) {
      world.set(ox + nextInt(rand, 5) - 2, oy, oz + nextInt(rand, 5) - 2, { Name: "minecraft:sculk_sensor", Properties: { power: "0", sculk_sensor_phase: "inactive", waterlogged: "false" } })
    }
  },

  async root_system(world, json, rand, resolvePlaced, ox, oy, oz) {
    const rootState = () => sampleState(json.root_state_provider, rand)
    const hangingState = () => sampleState(json.hanging_root_state_provider, rand)
    const rr = json.root_radius ?? 3
    for (let i = 0; i < (json.root_placement_attempts ?? 20); i++) {
      const dx = nextInt(rand, rr) - nextInt(rand, rr)
      const dz = nextInt(rand, rr) - nextInt(rand, rr)
      const dy = -1 - nextInt(rand, 2)
      world.set(ox + dx, oy + dy, oz + dz, rootState())
    }
    for (let dy = -1; dy >= -3; dy--) world.set(ox, oy + dy, oz, rootState())
    const hr = json.hanging_root_radius ?? 3
    for (let i = 0; i < (json.hanging_root_placement_attempts ?? 20); i++) {
      const dx = nextInt(rand, hr) - nextInt(rand, hr)
      const dz = nextInt(rand, hr) - nextInt(rand, hr)
      const dy = -3 - nextInt(rand, json.hanging_roots_vertical_span ?? 2)
      if (!world.get(ox + dx, oy + dy, oz + dz) && world.get(ox + dx, oy + dy + 1, oz + dz)) world.set(ox + dx, oy + dy, oz + dz, hangingState())
    }
    const inner = await resolvePlaced(json.feature)
    if (inner) await generate(world, inner, rand, resolvePlaced, ox, oy, oz)
  },

  async fossil(world, json, rand, resolvePlaced, ox, oy, oz) {
    if (!world.loadStruct) throw new Error("fossils need structure templates")
    const idx = nextInt(rand, json.fossil_structures.length)
    const fossil = await world.loadStruct(json.fossil_structures[idx])
    if (!fossil) throw new Error(`missing structure ${json.fossil_structures[idx]}`)
    mergeStructure(world, fossil, ox, oy, oz, 0.9, rand)
    // the _coal overlay stamps over the bones at 0.1 integrity; the diamond list
    // also swaps coal ore for deepslate diamond ore (vanilla's two processor lists)
    const overlay = json.overlay_structures ? await world.loadStruct(json.overlay_structures[idx]) : null
    if (overlay) {
      const diamonds = strip(json.overlay_processors ?? "").includes("diamond")
      const swap = e => diamonds && strip(e.Name) === "coal_ore" ? { ...e, Name: "minecraft:deepslate_diamond_ore" } : e
      mergeStructure(world, overlay, ox, oy, oz, 0.1, rand, swap)
    }
  },

  async template(world, json, rand, resolvePlaced, ox, oy, oz) {
    if (!world.loadStruct) throw new Error("templates need structure files")
    const entry = pickWeighted(json.templates, rand)
    const s = await world.loadStruct(entry.data.id ?? entry.data)
    if (!s) throw new Error(`missing structure ${entry.data.id ?? entry.data}`)
    mergeStructure(world, s, ox, oy, oz, 1, rand)
  }
})

function contextualState(world, p, rand, x, y, z) {
  if (strip(p.type ?? "") === "rule_based_state_provider") {
    for (const rule of p.rules ?? []) {
      if (testPredicate(world, rule.if_true, x, y, z)) return sampleState(rule.then, rand)
    }
    return p.fallback ? sampleState(p.fallback, rand) : null
  }
  return sampleState(p, rand)
}

function testPredicate(world, pred, x, y, z) {
  const [dx, dy, dz] = pred.offset ?? [0, 0, 0]
  const px = x + dx, py = y + dy, pz = z + dz
  switch (strip(pred.type)) {
    case "not": return !testPredicate(world, pred.predicate, px, py, pz)
    case "all_of": return (pred.predicates ?? []).every(p => testPredicate(world, p, px, py, pz))
    case "any_of": return (pred.predicates ?? []).some(p => testPredicate(world, p, px, py, pz))
    case "solid": {
      const c = world.get(px, py, pz)
      return !!c && !/(^|:)(water|lava)$/.test(c.Name)
    }
    case "matching_blocks": {
      const name = strip(world.get(px, py, pz)?.Name ?? "minecraft:air")
      return [pred.blocks].flat().map(strip).includes(name)
    }
    case "matching_fluids": {
      const c = world.get(px, py, pz)
      if (!c) return false
      const fluids = [pred.fluids].flat().map(strip)
      if (fluids.includes(strip(c.Name).replace("flowing_", ""))) return true
      return fluids.includes("water") && c.Properties?.waterlogged === "true"
    }
    case "matching_block_tag": return strip(pred.tag) === "air" ? !world.get(px, py, pz) : false
  }
  return true
}

// only offsets, scans and rarity matter for a single showcase placement;
// counts and biome/height filters have no meaning here
function applyPlacement(world, mods, rand, x, y, z) {
  for (const mod of mods ?? []) {
    switch (strip(mod.type)) {
      case "offset":
        x += mod.x ?? 0; y += mod.y ?? 0; z += mod.z ?? 0
        break
      case "rarity_filter":
        if (nextInt(rand, mod.chance) !== 0) return null
        break
      case "environment_scan": {
        const step = strip(mod.direction_of_search) === "down" ? -1 : 1
        let found = null
        for (let i = 0; i <= (mod.max_steps ?? 10); i++) {
          const py = y + i * step
          if (testPredicate(world, mod.target_condition, x, py, z)) { found = py; break }
          if (mod.allowed_search_condition && !testPredicate(world, mod.allowed_search_condition, x, py, z)) break
        }
        if (found === null) return null
        y = found
        break
      }
    }
  }
  return [x, y, z]
}

const STRUCT_AIR = /(^|:)(air|cave_air|void_air|structure_void|jigsaw|structure_block)$/

function mergeStructure(world, s, ox, oy, oz, keepChance, rand, mapState) {
  const cx = Math.floor(s.size[0] / 2), cz = Math.floor(s.size[2] / 2)
  for (const b of s.blocks) {
    const e = s.palette[b.state]
    if (!e?.Name || STRUCT_AIR.test(e.Name)) continue
    if (rand() >= keepChance) continue
    world.set(ox + b.pos[0] - cx, oy + b.pos[1], oz + b.pos[2] - cz, mapState ? mapState(e) : e)
  }
}

function isHat(cell, json) {
  return !!cell && cell.Name === json.hat_state.Name
}

function weepingColumn(world, x, y, z, totalHeight, minAge, maxAge, rand) {
  for (let h = 0; h <= totalHeight; h++) {
    if (world.get(x, y, z)) return
    if (h === totalHeight || world.get(x, y - 1, z)) {
      world.set(x, y, z, { Name: "minecraft:weeping_vines", Properties: { age: String(minAge + nextInt(rand, maxAge - minAge + 1)) } })
      return
    }
    world.set(x, y, z, { Name: "minecraft:weeping_vines_plant" })
    y--
  }
}

function mushroomHeight(rand) {
  let height = nextInt(rand, 3) + 4
  if (nextInt(rand, 12) === 0) height *= 2
  return height
}

function mushroomCap(provider, rand, faces) {
  const state = sampleState(provider, rand)
  const props = { ...(state.Properties ?? {}) }
  if ("up" in props || "west" in props) {
    for (const [k, v] of Object.entries({ down: false, ...faces })) {
      if (k in props) props[k] = String(v)
    }
  }
  return { Name: state.Name, Properties: props }
}

export const SUPPORTED = new Set(Object.keys(TYPES))

export async function generateFeature(name, json, rand, resolvePlaced, loadStruct, pad) {
  const world = makeWorld()
  world.loadStruct = loadStruct
  await generate(world, json, rand, resolvePlaced)

  // display-only (consumes no rand): trees get a grass layer one below origin,
  // icebergs get ocean from their keel up to sea level (the origin line), each
  // filling the air across the feature bounds and the 3-block tile border; the
  // border blocks sit outside the declared size so the tile lays out like any
  // other structure
  const type = strip(json.type ?? "")
  let padded = null
  if (pad && ["tree", "fallen_tree", "iceberg"].includes(type) && world.cells.size) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity
    for (const k of world.cells.keys()) {
      const [x, y, z] = k.split(",").map(Number)
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (z < z0) z0 = z
      if (z > z1) z1 = z
      if (y < y0) y0 = y
    }
    padded = { x0, x1, z0, z1 }
    for (let x = x0 - 3; x <= x1 + 3; x++) for (let z = z0 - 3; z <= z1 + 3; z++) {
      if (type === "iceberg") {
        for (let y = Math.min(y0, -1); y <= -1; y++) {
          if (!world.get(x, y, z)) world.set(x, y, z, { Name: "minecraft:water", Properties: { level: "0" } })
        }
      } else if (!world.get(x, -1, z)) {
        world.set(x, -1, z, { Name: "minecraft:grass_block", Properties: { snowy: "false" } })
      }
    }
  }

  let minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0
  for (const k of world.cells.keys()) {
    const [x, y, z] = k.split(",").map(Number)
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  if (padded) {
    minX = Math.min(0, padded.x0)
    maxX = Math.max(0, padded.x1)
    minZ = Math.min(0, padded.z0)
    maxZ = Math.max(0, padded.z1)
  }

  const { palette, stateFor } = statePicker()
  const blocks = []
  for (const [k, state] of world.cells) {
    const [x, y, z] = k.split(",").map(Number)
    blocks.push({ state: stateFor(state.Name, state.Properties), pos: [x - minX, y - minY, z - minZ] })
  }
  const structure = {
    size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1],
    palette, blocks, entities: [],
    anchor: [-minX, 0, -minZ]
  }
  if (padded && pad.grass) {
    for (const e of palette) {
      if (e.Name === "minecraft:grass_block") e.__biome = pad.grass
    }
  }
  return structure
}
