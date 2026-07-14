<script setup>
import { ref, watchEffect } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "../composables/usePacks.js"

const props = defineProps({
  id: String,
  components: Object,
  size: { type: Number, default: 32 }
})

const packs = usePacks()
const el = ref(null)

watchEffect(async () => {
  const c = el.value
  const { id, size } = props
  const components = props.components ?? {}
  if (!c || !id) return
  const lib = await loadLibrary()
  if (el.value !== c || props.id !== id) return
  c.getContext("2d").clearRect(0, 0, size, size)
  try {
    await lib.renderItem({
      id,
      assets: packs.assets.value,
      components,
      width: size,
      height: size,
      canvas: { canvas: c, x: 0, y: 0, width: size, height: size }
    })
  } catch {}
})
</script>

<template>
  <canvas ref="el" :width="size" :height="size" class="item-icon"></canvas>
</template>

<style scoped>
.item-icon {
  display: block;
  image-rendering: pixelated;
  flex-shrink: 0;
}
</style>
