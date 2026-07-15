<script setup>
import { computed } from "vue"

const props = defineProps({ value: Object })

const stripNs = s => s.replace(/^minecraft:/, "")
const part = (t, c) => ({ t, c })

function leafPart(v) {
  if (typeof v === "string") return part(stripNs(v), "str")
  if (typeof v === "boolean") return part(String(v), "bool")
  if (typeof v === "bigint") return part(String(v), "num")
  if (typeof v === "number") return part(String(Number.isInteger(v) ? v : Math.round(v * 1e4) / 1e4), "num")
  return part(String(v), "pun")
}

const isLeaf = v => v === null || typeof v !== "object"
const inlineArr = v => Array.isArray(v) && v.every(isLeaf)

const rows = computed(() => {
  const out = []
  function row(k, v, depth) {
    if (isLeaf(v)) out.push({ k, depth, parts: [leafPart(v)] })
    else if (inlineArr(v)) {
      const parts = [part("[", "pun")]
      v.forEach((e, i) => {
        if (i) parts.push(part(", ", "pun"))
        parts.push(leafPart(e))
      })
      parts.push(part("]", "pun"))
      out.push({ k, depth, parts })
    } else if (Array.isArray(v)) {
      out.push({ k, depth, mark: `[${v.length}]` })
      v.forEach((e, i) => row(String(i), e, depth + 1))
    } else if (!Object.keys(v).length) out.push({ k, depth, parts: [part("{}", "pun")] })
    else {
      out.push({ k, depth, mark: `{${Object.keys(v).length}}` })
      for (const [ck, cv] of Object.entries(v)) row(ck, cv, depth + 1)
    }
  }
  for (const [k, v] of Object.entries(props.value ?? {})) row(k, v, 0)
  return out
})
</script>

<template>
  <div class="nbt">
    <div v-for="(r, i) in rows" :key="i" class="nrow" :style="{ paddingLeft: 6 + r.depth * 16 + 'px' }">
      <span class="nk">{{ r.k }}</span>
      <span v-if="r.mark" class="nmark">{{ r.mark }}</span>
      <span v-else class="nv"><span v-for="(p, j) in r.parts" :key="j" :class="p.c">{{ p.t }}</span></span>
    </div>
  </div>
</template>

<style scoped>
.nbt {
  margin-top: 4px;
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
}

.nrow {
  display: flex;
  gap: 8px;
  padding: 2px 6px;
  border-radius: 4px;
}

.nrow:nth-child(even) { background: #ffffff05; }

.nk {
  color: var(--text-dim);
  flex-shrink: 0;
}

.nk::after { content: ":"; }

.nv { overflow-wrap: anywhere; }

.nmark { color: var(--text-dim); opacity: 0.7; }

.num { color: var(--accent); }
.str { color: var(--green); }
.bool { color: #d9a05b; }
.pun { color: var(--text-dim); }
</style>
