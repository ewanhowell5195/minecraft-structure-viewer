<script setup>
import { computed, ref } from "vue"
import { useComparePacks } from "../composables/useComparePacks.js"
import { useCompare } from "../composables/useCompare.js"
import { useWorld } from "../composables/useWorld.js"
import { useLock } from "../composables/useLock.js"
import PackStack from "./PackStack.vue"

const { state, activate, addPacks, removePack, movePack } = useComparePacks()
const compare = useCompare()
const cmp = compare.stateMut
const { state: worldState } = useWorld()
const { locked } = useLock()
const busy = computed(() => state.busy || locked.value)
const structInput = ref(null)
// a comparison restored from the url opens the panel it belongs to
const collapsed = ref(!new URLSearchParams(location.search).get("cversion"))

const VIEWS = [["slide", "Slide"], ["before", "Before"], ["after", "After"]]
const KINDS = [["added", "New"], ["changed", "Changed"], ["removed", "Removed"]]

function onStructure(e) {
  const file = e.target.files[0]
  e.target.value = ""
  if (file) compare.setPanelFile(file)
}
</script>

<template>
  <section :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      Compare
    </h2>
    <div v-if="worldState.active" class="hint">Not available with a world open</div>
    <template v-else>
      <PackStack target="compare" :state="state" :live="state.armed"
        @channel="channel => activate({ channel })" @add="addPacks" @move="movePack" @remove="removePack" />
      <div v-if="!state.armed" class="hint">Pick a version to compare the loaded structure against, packs and all</div>
      <template v-else>
        <button v-if="compare.fileName('panel')" class="wide" :disabled="busy" :title="compare.fileName('panel')"
          @click="compare.clearFile('panel')">
          <span class="material-symbols-outlined">close</span>
          Close Structure File
        </button>
        <button v-else class="wide" :disabled="busy" title="Compare against this file instead of the main side's structure"
          @click="structInput.click()">
          <span class="material-symbols-outlined">upload_file</span>
          Open Structure File
        </button>
        <template v-if="cmp.on">
          <label class="lbl">Compare mode</label>
          <div class="seg">
            <button v-for="[id, label] in VIEWS" :key="id" :class="{ active: cmp.view === id }"
              @click="cmp.view = id">{{ label }}</button>
          </div>
          <label class="lbl">Highlights</label>
          <div class="checks">
            <label v-for="[id, label] in KINDS" :key="id" class="check" :class="id">
              <input type="checkbox" v-model="cmp.show[id]">
              {{ label }} blocks/entities
              <span class="count">{{ cmp.counts[id].toLocaleString("en") }}</span>
            </label>
          </div>
        </template>
        <button class="wide" :disabled="busy" @click="compare.stop()">
          <span class="material-symbols-outlined">close</span>
          Stop Comparing
        </button>
      </template>
    </template>
    <input ref="structInput" type="file" accept=".nbt,.litematic,.schem,.mcstructure" hidden @change="onStructure">
  </section>
</template>

<style scoped>
.seg button { flex: 1; }

.hint {
  font-size: 12px;
  color: var(--text-dim);
}

.lbl {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  user-select: none;
}

/* the swatch matches the overlay colour the toggle draws with */
.check::before {
  content: "";
  width: 10px;
  height: 10px;
  border-radius: 2px;
  order: -1;
}

.check.added::before { background: #6fd487; }
.check.changed::before { background: #f0c85a; }
.check.removed::before { background: #ff6b82; }

.check .count {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
</style>
