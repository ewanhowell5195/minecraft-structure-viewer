<script setup>
import { computed } from "vue"
import { useBuild } from "../composables/useBuild.js"
import Modal from "./Modal.vue"

const buildApi = useBuild()
const { state } = buildApi

const time = computed(() => {
  const s = state.warn?.seconds ?? 0
  if (s < 90) return `~${s} seconds`
  return `~${(s / 60).toFixed(s < 600 ? 1 : 0)} minutes`
})
</script>

<template>
  <Modal v-if="state.warn" :width="340" :z="250" :closable="false" :dismissable="false" style="--modal-gap: 0px" class="bw">
    <h3>Large build</h3>
    <p>This structure is estimated to take <strong>{{ time }}</strong> to build on this machine.</p>
    <div class="row">
      <button class="primary" @click="buildApi.answerWarn(true)">Build anyway</button>
      <button @click="buildApi.answerWarn(false)">Cancel</button>
    </div>
  </Modal>
</template>

<style scoped>
.bw :deep(.modal-panel) {
  padding: 18px 20px;
  box-shadow: 0 10px 40px #00000080;
}

h3 {
  margin: 0 0 8px;
  font-size: 15px;
}

p {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--text-dim);
}

p strong { color: var(--text); }

.row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
