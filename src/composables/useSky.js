import { computed, ref, watch } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "./usePacks.js"
import { useBuild } from "./useBuild.js"
import { useScene } from "./useScene.js"
import { useWalk } from "./useWalk.js"

const packs = usePacks()
const build = useBuild()
const scene = useScene()
const walk = useWalk()

// walking is always under the sky; orbiting only when the view toggle asks for it
const param = new URLSearchParams(location.search).get("sky")
const enabled = ref(param !== null && param !== "false")
const active = computed(() => walk.state.on || enabled.value)

let handle = null
let token = 0

function clear() {
  if (!handle) return
  scene.setSky(null)
  handle.dispose()
  handle = null
}

async function apply() {
  const id = ++token
  const assets = packs.assets.value
  if (!active.value || !assets) return clear()
  const lib = await loadLibrary()
  let next
  try {
    next = await lib.createSky(assets, {
      dimension: build.state.dimension,
      daytime: build.state.daytime,
      version: packs.state.baseId || undefined
    })
  } catch {
    return
  }
  if (id !== token) return next.dispose()
  clear()
  handle = next
  scene.setSky(next.group)
}

watch([active, () => packs.assets.value, () => build.state.dimension], apply, { immediate: true })
watch(() => build.state.daytime, v => {
  if (handle) handle.daytime.value = v
})

export function useSky() {
  return { enabled, active }
}
