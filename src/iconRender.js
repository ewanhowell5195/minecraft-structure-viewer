export async function renderIcon(lib, assets, spec, extra) {
  const size = spec.size
  const args = { assets, width: size, height: size, ...extra }
  if (spec.kind === "block") {
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
    return null
  }
  return lib.renderItem({
    ...args,
    id: spec.id,
    components: spec.components ?? {}
  })
}
