import * as THREE from "three"
import { templateBoxes } from "../streamShared.js"

const _wp = new THREE.Vector3()

// dynamic-model blocks (chests, banners, bells, enchanting tables...) carry
// live part rigs and pose methods the packed tile format can't ship, so each
// tile builds them on the main thread as a small live createScene of their
// own. The group sits outside the frozen tile subtree so poses keep animating,
// and its materials bind the tile's light volume through a light shim
export async function attachTileDynamics({ lib, assets, blocks, lightMat, sharedAtlas, dimension, daytime, lightOff }) {
  if (!blocks?.length) return null
  const u = lightMat?.uniforms
  const lightShim = !lightOff && u?.lightVol ? {
    uniforms: {
      lightVol: u.lightVol, lightVolOrigin: u.lightVolOrigin, lightVolSize: u.lightVolSize,
      lightVolTex: u.lightVolTex, lightVolCols: u.lightVolCols
    }
  } : false
  const input = blocks.map(d => {
    const e = { id: d.id, pos: d.pos }
    if (d.properties) e.properties = d.properties
    if (d.nbt) e.nbt = d.nbt
    return e
  })
  const handle = await lib.createScene(assets, input, {
    lighting: { dimension, daytime, light: lightShim },
    keepTemplates: true,
    ignoreAtlases: true,
    technical: false,
    animate: false,
    sliceMs: 8,
    sharedAtlas
  })
  if (!handle) return null
  const regs = new Map()
  blocks.forEach((d, i) => regs.set(d.pos.join(","), { pos: d.pos, id: d.id, properties: d.properties, nbt: d.nbt, i }))
  const boxCache = new Map()
  // chest and shulker lids, pot wobbles and bell rings keep per-placement pose
  // rigs; index them by cell
  const lids = new Map()
  handle.group.updateMatrixWorld(true)
  handle.group.traverse(o => {
    const kind = o.userData?.dynamic
    if (kind !== "chest" && kind !== "shulker_box" && kind !== "decorated_pot" && kind !== "bell") return
    if (typeof o.open !== "function" && typeof o.wobble !== "function" && typeof o.ring !== "function") return
    o.getWorldPosition(_wp)
    lids.set([Math.floor(_wp.x / 16), Math.floor(_wp.y / 16), Math.floor(_wp.z / 16)].join(","), o)
  })
  return {
    setLid(pos, on) {
      const l = lids.get(pos.join(","))
      if (l?.open) on ? l.open() : l.close()
    },
    wobble(pos) {
      lids.get(pos.join(","))?.wobble?.("positive")
    },
    ring(pos, dir) {
      lids.get(pos.join(","))?.ring?.(dir)
    },
    group: handle.group,
    regs,
    animator: lib.createAnimator?.(handle.group) ?? null,
    boxesFor(reg) {
      const ti = handle.blockTemplate?.[reg.i]
      if (ti == null || ti === 0xFFFFFFFF) return []
      let b = boxCache.get(ti)
      if (!b) {
        const tmpl = handle.templates?.[ti]
        b = tmpl?.group ? templateBoxes(tmpl.group) : []
        boxCache.set(ti, b)
      }
      return b
    },
    dispose() {
      handle.group.removeFromParent()
      try { handle.dispose?.() } catch {}
    }
  }
}
