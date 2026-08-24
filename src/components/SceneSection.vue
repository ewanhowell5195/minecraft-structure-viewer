<script setup>
import { ref } from "vue"
import { useBuild } from "../composables/useBuild.js"
import { useStructure } from "../composables/useStructure.js"
import { useScene } from "../composables/useScene.js"
import { useSky } from "../composables/useSky.js"
import { useLock } from "../composables/useLock.js"
import { fileBase } from "../transforms.js"

const { state: buildState, exportCurrent } = useBuild()
const { state: structureState } = useStructure()
const sceneApi = useScene()
const { enabled: skyOn } = useSky()
const { locked } = useLock()
const collapsed = ref(false)

const angle = ref("current")
const quality = ref(1)
const aa = ref(true)
const crop = ref(false)
const sky = ref(false)
const rendering = ref(false)

const ANGLES = [
  ["current", "Current"], ["south", "South"], ["southeast", "South East"], ["east", "East"],
  ["northeast", "North East"], ["north", "North"], ["northwest", "North West"], ["west", "West"],
  ["southwest", "South West"], ["top", "Top"]
]

function onExport(ev) {
  const v = ev.target.value
  ev.target.value = ""
  if (v) exportCurrent(v, structureState.name)
}

async function render() {
  rendering.value = true
  try {
    const blob = await sceneApi.renderShot({
      scale: quality.value,
      aa: aa.value,
      angle: angle.value,
      crop: crop.value,
      sky: skyOn.value && sky.value
    })
    if (!blob) return
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `${fileBase(structureState.name)}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  } finally {
    rendering.value = false
  }
}
</script>

<template>
  <section :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      Scene
    </h2>
    <div class="fields">
      <label for="export">Export</label>
      <select id="export" :disabled="locked || !buildState.info" @change="onExport">
        <option value="" selected>Save as…</option>
        <option value="glb">.glb</option>
        <option value="obj">.obj (zip)</option>
      </select>
      <label for="rangle">Angle</label>
      <select id="rangle" v-model="angle">
        <option v-for="[id, label] in ANGLES" :key="id" :value="id">{{ label }}</option>
      </select>
      <label for="rquality">Quality</label>
      <select id="rquality" v-model.number="quality">
        <option :value="1">1x</option>
        <option :value="2">2x</option>
        <option :value="4">4x</option>
      </select>
    </div>
    <div class="checks">
      <label class="check" title="Render at double size and downscale by half">
        <input type="checkbox" v-model="aa">
        Anti-aliasing
      </label>
      <label class="check" title="Crop the image to the structure instead of the viewport">
        <input type="checkbox" v-model="crop">
        Crop to model
      </label>
      <label v-if="skyOn" class="check" title="Include the sky, or keep the background transparent">
        <input type="checkbox" v-model="sky">
        Sky
      </label>
    </div>
    <button :disabled="locked || rendering || !buildState.info" @click="render">
      <span class="material-symbols-outlined">photo_camera</span>
      Render PNG
    </button>
  </section>
</template>

<style scoped>
.fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px;
  align-items: center;
}

button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

button .material-symbols-outlined { font-size: 18px; }
</style>
