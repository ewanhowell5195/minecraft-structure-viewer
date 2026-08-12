<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue"
import { acquireIcon, releaseIcon, nextToken, onVisible, offVisible } from "../icons.js"
import { getFont, measure, drawText } from "../mcfont.js"

const props = defineProps({
  kind: { type: String, default: "block" },
  id: String,
  blockstates: Object,
  components: Object,
  size: { type: Number, default: 32 }
})

const STAND_INS = { cushion: "red_cushion", item: "stick" }

const el = ref(null)
let rendered = false
const token = nextToken()
let held = null

async function render() {
  if (rendered) return
  rendered = true
  const host = el.value
  if (!host || !props.id) return
  const size = props.size
  const bare = props.id.replace(/^minecraft:/, "")
  const spec = props.kind === "entity"
    ? { kind: "entity", candidates: STAND_INS[bare] ? [STAND_INS[bare]] : [bare + "_spawn_egg", bare], size }
    : props.kind === "item"
      ? { kind: "item", id: props.id, components: props.components ?? {}, size }
      : { kind: "block", id: props.id, blockstates: props.blockstates ?? {}, size }
  const got = await acquireIcon(spec, token, size)
  if (el.value !== host) {
    if (got?.animated) releaseIcon(spec, token)
    return
  }

  if (got) {
    if (got.animated) held = spec
    host.replaceChildren(got.canvas)
    return
  }

  if (props.kind !== "entity") return
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = size
  const ctx = canvas.getContext("2d")
  const font = await getFont()
  const s = Math.max(1, Math.round(size / 12))
  const x = Math.round((size - measure(font, "?") * s) / 2)
  const y = Math.round((size - font.ch * s) / 2)
  drawText(ctx, font, "?", x + s, y + s, { scale: s, color: "#3f3f3f" })
  drawText(ctx, font, "?", x, y, { scale: s, color: "#ffffff" })
  host.replaceChildren(canvas)
}

onMounted(() => onVisible(el.value, render))
onBeforeUnmount(() => {
  offVisible(el.value)
  if (held) {
    releaseIcon(held, token)
    held = null
  }
})
</script>

<template>
  <div ref="el" class="used-icon" :style="{ width: size + 'px', height: size + 'px' }"></div>
</template>

<style scoped>
.used-icon {
  display: block;
  flex-shrink: 0;
}

.used-icon :deep(canvas) {
  display: block;
  image-rendering: pixelated;
}
</style>
