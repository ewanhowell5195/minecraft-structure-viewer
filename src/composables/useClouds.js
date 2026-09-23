import { ref, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useBuild } from "./useBuild.js"
import { useScene } from "./useScene.js"
import { useSky } from "./useSky.js"
import { useWorld } from "./useWorld.js"
import { useStream } from "./useStream.js"
import { useWalk } from "./useWalk.js"
import { THREE } from "../lib.js"

const CLOUD_HEIGHT = 192.33

const packs = usePacks()
const build = useBuild()
const scene = useScene()
const sky = useSky()
const world = useWorld()
const stream = useStream()
const walk = useWalk()

const enabled = ref(false)

let handle = null
let token = 0

// streamed tiles sit at world coordinates, orbit builds at the selection's bottom, structures at their own floor
function baseY() {
  if (stream.state.session) return 0.5
  return world.getLastSelection()?.worldOrigin?.[1] ?? 0
}

function place() {
  if (!handle) return
  handle.height = CLOUD_HEIGHT - baseY()
  handle.group.visible = sky.skyDim.value === "overworld"
  const left = stream.state.session && !stream.state.on ? stream.exitPosition() : null
  handle.anchor = walk.state.on || stream.state.on ? null : left ? [left.x, left.y, left.z] : stream.state.session ? null : scene.sceneBounds().getCenter(new THREE.Vector3())
}

function clear() {
  if (!handle) return
  scene.setClouds(null)
  handle.dispose()
  handle = null
}

async function apply() {
  const id = ++token
  const assets = packs.assets.value
  if (!enabled.value || !assets) return clear()
  const lib = await loadLibrary()
  if (!lib.createClouds) return
  let next
  try {
    next = await lib.createClouds(assets, { daytime: build.state.daytime })
  } catch {
    return
  }
  if (id !== token) return next.dispose()
  clear()
  handle = next
  place()
  scene.setClouds(handle.group)
}

watch([enabled, () => packs.assets.value], apply, { immediate: true })
watch(() => build.state.daytime, v => {
  if (handle) handle.daytime.value = v
})
watch([() => build.state.landed, () => stream.state.session, () => stream.state.on, sky.skyDim, () => walk.state.on], place)

export function useClouds() {
  return { enabled }
}
