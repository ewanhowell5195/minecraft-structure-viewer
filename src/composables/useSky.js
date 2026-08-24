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

const enabled = ref(!new URLSearchParams(location.search).has("nosky"))
const active = computed(() => walk.state.on || enabled.value)

// "auto" follows the structure's own dimension; the sky toggle off pins the
// lightmap back to overworld
const dimension = ref("auto")
const skyDim = computed(() => dimension.value === "auto" ? build.state.dimension : dimension.value)
const lightDim = computed(() => enabled.value ? skyDim.value : "overworld")
build.setLightDimSource(() => lightDim.value)

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
      dimension: skyDim.value,
      daytime: build.state.daytime,
      // no terrain here to hide them the way the game does
      horizonFade: true,
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

watch([active, () => packs.assets.value, skyDim], apply, { immediate: true })
watch(() => build.state.daytime, v => {
  if (handle) handle.daytime.value = v
})

// a lightmap change rebuilds like the lighting toggles do; a build in flight is
// the one that moved state.dimension, so it already carries the new value
watch(lightDim, async () => {
  if (!build.getRoot() || build.state.building) return
  const { useCompare } = await import("./useCompare.js")
  if (useCompare().state.on) return
  build.build(undefined, false)
})

export function useSky() {
  return { enabled, active, dimension, skyDim, lightDim }
}
