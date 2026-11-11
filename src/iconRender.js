import { EGG_COLORS } from "./eggColors.js"
import { legacyAssetAlias } from "./legacyItems.js"

export function renderSpawnEgg(lib, assets, entity, args) {
  const tints = EGG_COLORS[entity.replace(/^minecraft:/, "")]
  if (!tints) return null
  return lib.renderModel({ ...args, assets, model: { parent: "minecraft:item/template_spawn_egg", tints } })
}

export async function renderIcon(lib, assets, spec, extra) {
  const size = spec.size
  const args = { assets, width: size, height: size, ...extra }
  if (spec.kind === "block") {
    const [ns, name] = spec.id.includes(":") ? spec.id.split(":") : ["minecraft", spec.id]
    if (await lib.readFile(assets, `assets/${ns}/items/${name}.json`) || await lib.readFile(assets, `assets/${ns}/models/item/${name}.json`)) {
      return lib.renderItem({ ...args, id: spec.id })
    }
    return lib.renderBlock({
      ...args,
      id: spec.id,
      properties: spec.blockstates ?? {},
      display: { type: "fallback", rotateFlat: true, ...lib.DISPLAYS.block }
    })
  }
  if (spec.kind === "entity") {
    for (const item of spec.candidates) {
      if (!await lib.readFile(assets, `assets/minecraft/items/${item}.json`)) continue
      return lib.renderItem({ ...args, id: item })
    }
    // pre-1.21.4 assets have no item definitions: eggs render from the
    // template with hardcoded tints, anything else from its item model
    for (const item of spec.candidates) {
      const m = item.match(/^(.+)_spawn_egg$/)
      if (m) {
        const egg = renderSpawnEgg(lib, assets, m[1], args)
        if (egg) return egg
      }
      if (!await lib.readFile(assets, `assets/minecraft/models/item/${item}.json`)) continue
      return lib.renderItem({ ...args, id: item })
    }
    return null
  }
  let id = spec.id
  const [ns, name] = id.includes(":") ? id.split(":") : ["minecraft", id]
  if (!await lib.readFile(assets, `assets/${ns}/items/${name}.json`) && !await lib.readFile(assets, `assets/${ns}/models/item/${name}.json`)) {
    const alias = legacyAssetAlias(name)
    if (alias && await lib.readFile(assets, `assets/${ns}/models/item/${alias}.json`)) id = `${ns}:${alias}`
  }
  return lib.renderItem({
    ...args,
    id,
    components: spec.components ?? {}
  })
}
