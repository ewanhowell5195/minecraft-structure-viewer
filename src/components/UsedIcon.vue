<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue"
import { loadLibrary } from "../lib.js"
import { usePacks } from "../composables/usePacks.js"
import { getFont, measure, drawText } from "../mcfont.js"

const props = defineProps({
  kind: { type: String, default: "block" },
  id: String,
  blockstates: Object,
  size: { type: Number, default: 32 }
})

const packs = usePacks()
const el = ref(null)
let rendered = false

// one shared observer so a long list only renders icons as they scroll in
let observer = null
const pending = new WeakMap()
function observe(target, fn) {
  observer ??= new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue
      observer.unobserve(en.target)
      const cb = pending.get(en.target)
      pending.delete(en.target)
      cb?.()
    }
  })
  pending.set(target, fn)
  observer.observe(target)
}

async function render() {
  if (rendered) return
  rendered = true
  const c = el.value
  if (!c || !props.id) return
  const lib = await loadLibrary()
  const assets = packs.assets.value
  const size = props.size
  try {
    if (props.kind === "entity") {
      const bare = props.id.replace(/^minecraft:/, "")
      const candidates = bare === "cushion" ? ["red_cushion"] : [bare + "_spawn_egg", bare]
      for (const item of candidates) {
        if (!await lib.readFile(`assets/minecraft/items/${item}.json`, assets)) continue
        await lib.renderItem({ id: item, assets, width: size, height: size, canvas: c })
        return
      }
      const font = await getFont()
      const s = Math.max(1, Math.round(size / 12))
      const ctx = c.getContext("2d")
      const x = Math.round((size - measure(font, "?") * s) / 2)
      const y = Math.round((size - font.ch * s) / 2)
      drawText(ctx, font, "?", x + s, y + s, { scale: s, color: "#3f3f3f" })
      drawText(ctx, font, "?", x, y, { scale: s, color: "#ffffff" })
    } else {
      await lib.renderBlock({
        id: props.id,
        assets,
        blockstates: props.blockstates ?? {},
        width: size,
        height: size,
        canvas: c,
        ignoreAtlases: true,
        display: { type: "fallback", rotateFlat: true, ...lib.DISPLAYS.block }
      })
    }
  } catch {}
}

onMounted(() => observe(el.value, render))
onBeforeUnmount(() => {
  if (el.value) {
    observer?.unobserve(el.value)
    pending.delete(el.value)
  }
})
</script>

<template>
  <canvas ref="el" :width="size" :height="size" class="used-icon"></canvas>
</template>

<style scoped>
.used-icon {
  display: block;
  image-rendering: pixelated;
  flex-shrink: 0;
}
</style>
