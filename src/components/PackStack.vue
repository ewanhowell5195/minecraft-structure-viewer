<script setup>
import { computed, ref } from "vue"
import { useLock } from "../composables/useLock.js"
import VersionModal from "./VersionModal.vue"

// the version row and pack list, shared by the main Packs section and the
// comparison panel: same controls, different stack behind them
const props = defineProps({
  target: { type: String, default: "packs" },
  state: { type: Object, required: true },
  // the pin and channel buttons only light up once the stack is in use
  live: { type: Boolean, default: true }
})
const emit = defineEmits(["channel", "add", "move", "remove"])

const { locked } = useLock()
const busy = computed(() => props.state.busy || locked.value)
const fileInput = ref(null)
const versionModal = ref(false)

const TYPES = { release: "Release", snapshot: "Snapshot", old_beta: "Beta", old_alpha: "Alpha" }

const baseLabel = computed(() => {
  const s = props.state
  if (s.baseStatus || !s.baseId) return s.baseStatus
  return `${s.version ? "" : "Latest "}${TYPES[s.baseType] ?? "Version"} · ${s.baseId}`
})

const failed = computed(() => props.state.baseFailed ?? /failed|not found/.test(props.state.baseStatus))

function onFiles(e) {
  emit("add", Array.from(e.target.files))
  e.target.value = ""
}
</script>

<template>
  <div class="channel">
    <button :class="{ active: live && !state.version && state.channel === 'release' }" :disabled="busy"
      @click="emit('channel', 'release')">Release</button>
    <button :class="{ active: live && !state.version && state.channel === 'snapshot' }" :disabled="busy"
      @click="emit('channel', 'snapshot')">Snapshot</button>
    <button class="pin" :class="{ active: live && !!state.version }" :disabled="busy"
      :title="state.version ? `Pinned to ${state.version}` : 'Pick an exact version'"
      @click="versionModal = true">
      <span class="material-symbols-outlined">tune</span>
    </button>
  </div>
  <VersionModal v-if="versionModal" :target="target" @close="versionModal = false" />
  <template v-if="live">
    <div class="pack-list">
      <div v-for="(p, i) in state.packs" :key="p.id" class="pack">
        <span class="material-symbols-outlined kind">folder_zip</span>
        <span class="name" :title="p.name">{{ p.name }}</span>
        <template v-if="state.packs.length > 1">
          <button class="icon" title="Move up" :disabled="busy || i === 0"
            @click="emit('move', p.id, -1)"><span class="material-symbols-outlined">keyboard_arrow_up</span></button>
          <button class="icon" title="Move down" :disabled="busy || i === state.packs.length - 1"
            @click="emit('move', p.id, 1)"><span class="material-symbols-outlined">keyboard_arrow_down</span></button>
        </template>
        <button class="icon" title="Remove" :disabled="busy"
          @click="emit('remove', p.id)"><span class="material-symbols-outlined">close</span></button>
      </div>
      <div class="pack base" :class="{ failed }">
        <span class="material-symbols-outlined kind">deployed_code</span>
        <span class="name">{{ baseLabel }}</span>
        <span v-if="state.baseProgress" class="bar" :style="{ transform: `scaleX(${state.baseProgress})` }"></span>
      </div>
    </div>
    <button class="wide" :disabled="busy" @click="fileInput.click()">
      <span class="material-symbols-outlined">add</span>
      Add Resource Pack or Mod
    </button>
    <input ref="fileInput" type="file" accept=".zip,.jar" multiple hidden @change="onFiles">
  </template>
</template>
