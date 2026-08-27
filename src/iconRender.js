export async function renderIcon(lib, assets, spec, extra) {
  const size = spec.size
  const args = { assets, width: size, height: size, ...extra }
  if (spec.kind === "block") {
    const [ns, name] = spec.id.includes(":") ? spec.id.split(":") : ["minecraft", spec.id]
    if (await lib.readFile(`assets/${ns}/items/${name}.json`, assets) || await lib.readFile(`assets/${ns}/models/item/${name}.json`, assets)) {
      return lib.renderItem({ ...args, id: spec.id, ignoreAtlases: true })
    }
    return lib.renderBlock({
      ...args,
      id: spec.id,
      blockstates: spec.blockstates ?? {},
      ignoreAtlases: true,
      display: { type: "fallback", rotateFlat: true, ...lib.DISPLAYS.block }
    })
  }
  if (spec.kind === "entity") {
    for (const item of spec.candidates) {
      if (!await lib.readFile(`assets/minecraft/items/${item}.json`, assets)) continue
      return lib.renderItem({ ...args, id: item })
    }
    // pre-1.21.4 assets have no item definitions, so probe the item models
    for (const item of spec.candidates) {
      if (!await lib.readFile(`assets/minecraft/models/item/${item}.json`, assets)) continue
      return lib.renderItem({ ...args, id: item })
    }
    return null
  }
  return lib.renderItem({
    ...args,
    id: spec.id,
    components: spec.components ?? {}
  })
}
