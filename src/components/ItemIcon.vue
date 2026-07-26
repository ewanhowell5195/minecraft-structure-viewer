<script setup>
import { onBeforeUnmount, onMounted, ref, watchEffect } from "vue"
import { usePacks } from "../composables/usePacks.js"
import { acquireIcon, releaseIcon, nextToken, onVisible, offVisible } from "../icons.js"

const props = defineProps({
  id: String,
  components: Object,
  size: { type: Number, default: 32 }
})

const packs = usePacks()
const el = ref(null)
const shown = ref(false)
const token = nextToken()
let held = null

function clear() {
  if (held) {
    releaseIcon(held, token)
    held = null
  }
  if (el.value) el.value.replaceChildren()
}

watchEffect(async () => {
  const host = el.value
  const { id, size } = props
  const components = props.components ?? {}
  const version = packs.state.assetsVersion
  if (!host || !id || !shown.value) return
  clear()
  const spec = { kind: "item", id, components, size }
  const got = await acquireIcon(spec, token, size)
  if (el.value !== host || props.id !== id || packs.state.assetsVersion !== version) {
    if (got?.animated) releaseIcon(spec, token)
    return
  }
  if (!got) return
  if (got.animated) held = spec
  host.replaceChildren(got.canvas)
})

onMounted(() => onVisible(el.value, () => shown.value = true))
onBeforeUnmount(() => {
  offVisible(el.value)
  clear()
})
</script>

<template>
  <div ref="el" class="item-icon" :style="{ width: size + 'px', height: size + 'px' }"></div>
</template>

<style scoped>
.item-icon {
  display: block;
  flex-shrink: 0;
}

.item-icon :deep(canvas) {
  display: block;
  image-rendering: pixelated;
}
</style>
