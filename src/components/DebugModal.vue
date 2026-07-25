<script setup>
import { DEBUG_SCENES } from "../debug.js"
import Modal from "./Modal.vue"

const emit = defineEmits(["close"])

const href = kind => {
  const u = new URL(location)
  u.searchParams.set("debug", kind || "1")
  return u.pathname + u.search
}
</script>

<template>
  <Modal :width="520" @close="emit('close')">
    <template #title><h2>Debug scenes</h2></template>
    <div class="pane">
      <a v-for="s in DEBUG_SCENES" :key="s.kind" class="row" :href="href(s.kind)">
        <div class="name">{{ s.name }}</div>
        <div class="desc">{{ s.desc }}</div>
        <code>?debug={{ s.kind || "1" }}</code>
      </a>
    </div>
  </Modal>
</template>

<style scoped>
.pane {
  padding: 8px;
  max-height: 70vh;
  overflow-y: auto;
}

.row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 12px;
  padding: 8px 10px;
  border-radius: 4px;
  color: inherit;
  text-decoration: none;
}

.row:hover {
  background: #ffffff14;
}

.name {
  font-weight: 600;
}

.desc {
  grid-column: 1;
  font-size: 12px;
  opacity: 0.7;
}

code {
  grid-row: 1 / 3;
  grid-column: 2;
  align-self: center;
  font-size: 12px;
  opacity: 0.6;
  white-space: nowrap;
}
</style>
