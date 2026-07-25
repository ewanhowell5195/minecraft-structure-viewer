// the render branches behind every GUI icon, shared by the icon worker and the
// main-thread fallback so both paths produce identical output. `extra` carries
// the mode: `upgradable` in the worker to learn whether an icon animates,
// `animated` on main to build the player that actually plays it
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
