<script setup>
import { computed, ref } from "vue"
import { usePacks } from "../composables/usePacks.js"
import { useLock } from "../composables/useLock.js"

const { state, setChannel, addPacks, removePack, movePack } = usePacks()
const { locked } = useLock()
const busy = computed(() => state.busy || locked.value)
const fileInput = ref(null)
const collapsed = ref(false)

function onFiles(e) {
  addPacks(Array.from(e.target.files))
  e.target.value = ""
}
</script>

<template>
  <section :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      Packs
    </h2>
    <div class="channel">
      <button :class="{ active: !state.version && state.channel === 'release' }" :disabled="busy"
        @click="setChannel('release')">Release</button>
      <button :class="{ active: !state.version && state.channel === 'snapshot' }" :disabled="busy"
        @click="setChannel('snapshot')">Snapshot</button>
    </div>
    <div class="pack-list">
      <div v-for="(p, i) in state.packs" :key="p.id" class="pack">
        <span class="material-symbols-outlined kind">folder_zip</span>
        <span class="name" :title="p.name">{{ p.name }}</span>
        <template v-if="state.packs.length > 1">
          <button class="icon" title="Move up" :disabled="busy || i === 0"
            @click="movePack(p.id, -1)"><span class="material-symbols-outlined">keyboard_arrow_up</span></button>
          <button class="icon" title="Move down" :disabled="busy || i === state.packs.length - 1"
            @click="movePack(p.id, 1)"><span class="material-symbols-outlined">keyboard_arrow_down</span></button>
        </template>
        <button class="icon" title="Remove" :disabled="busy"
          @click="removePack(p.id)"><span class="material-symbols-outlined">close</span></button>
      </div>
      <div class="pack base" :class="{ failed: state.baseFailed }">
        <span class="material-symbols-outlined kind">deployed_code</span>
        <span class="name">{{ state.baseId ? `Vanilla ${state.baseId}` : state.baseStatus }}</span>
      </div>
    </div>
    <button class="add" :disabled="busy" @click="fileInput.click()">
      <span class="material-symbols-outlined">add</span>
      Add Resource Pack or Mod
    </button>
    <input ref="fileInput" type="file" accept=".zip,.jar" multiple hidden @change="onFiles">
  </section>
</template>

<style scoped>
.channel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.channel button.active {
  background: var(--green);
  border-color: transparent;
  color: #fff;
}

.pack-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pack {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 8px;
  min-height: 32px;
}

.pack .kind {
  color: var(--text-dim);
  font-size: 18px;
  flex-shrink: 0;
}

.pack .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.pack.base .name { color: var(--text-dim); }
.pack.base.failed .name { color: var(--red); }

button.icon {
  padding: 0;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  background: none;
  border: none;
  color: var(--text-dim);
  flex-shrink: 0;
}

button.icon:hover:not(:disabled) {
  background: #ffffff14;
  color: var(--text);
}

button.icon .material-symbols-outlined { font-size: 18px; }

.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
}

.add .material-symbols-outlined { font-size: 18px; }
</style>
