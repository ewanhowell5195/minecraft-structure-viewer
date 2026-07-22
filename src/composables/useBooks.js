import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"

const sceneApi = useScene()

let lids = new Map()
let rangeDefault = 16

function setRange(blocks) {
  rangeDefault = blocks
  sceneApi.scene.traverse(o => {
    if (o.userData?.dynamic === "enchanting_book") o.userData.range = blocks
  })
}

function setLid(pos, on) {
  const entry = lids.get(pos.join(","))
  if (!entry) return
  if (on) entry.open?.()
  else entry.close?.()
}

function wobble(pos) {
  lids.get(pos.join(","))?.wobble?.("positive")
}

function ring(pos, dir) {
  lids.get(pos.join(","))?.ring?.(dir)
}

const _v = new THREE.Vector3()

function refresh() {
  lids = new Map()
  const root = useBuild().getRoot()
  sceneApi.scene.updateMatrixWorld(true)
  sceneApi.scene.traverse(o => {
    const kind = o.userData?.dynamic
    if (!kind) return
    if (kind === "enchanting_book") {
      o.userData.range = rangeDefault
    } else if ((kind === "chest" || kind === "shulker_box" || kind === "decorated_pot" || kind === "bell") && root) {
      o.getWorldPosition(_v)
      const key = [
        Math.floor((_v.x - root.position.x) / 16),
        Math.floor((_v.y - root.position.y) / 16),
        Math.floor((_v.z - root.position.z) / 16)
      ].join(",")
      lids.set(key, o)
    }
  })
}

export function useBooks() {
  return { refresh, setLid, setRange, wobble, ring }
}
