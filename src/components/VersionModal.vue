<script setup>
import { computed, ref, onMounted } from "vue"
import { listVersions } from "../mojang.js"
import { usePacks } from "../composables/usePacks.js"
import { useLock } from "../composables/useLock.js"
import Modal from "./Modal.vue"

const emit = defineEmits(["close"])
const { state, setVersion } = usePacks()
const { locked } = useLock()

const versions = ref([])
const latest = ref({})
const error = ref("")
const query = ref("")
const kind = ref("release")

onMounted(async () => {
  try {
    const m = await listVersions()
    versions.value = m.versions
    latest.value = m.latest
  } catch {
    error.value = "couldn't reach the version manifest"
  }
})

const KINDS = [
  { id: "release", label: "Releases", match: v => v.type === "release" },
  { id: "snapshot", label: "Snapshots", match: v => v.type === "snapshot" }
]

const FIRST = "15w31a"
const modern = id => {
  const m = /^(\d+)\.(\d+)/.exec(id)
  return !!m && (+m[1] > 1 || +m[2] >= 9)
}

const usable = computed(() => {
  const cut = versions.value.findIndex(v => v.id === FIRST)
  const rows = cut === -1 ? versions.value : versions.value.slice(0, cut + 1)
  return rows.filter(v => v.type === "snapshot" || (v.type === "release" && modern(v.id)))
})

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  const match = KINDS.find(k => k.id === kind.value).match
  return usable.value.filter(v => match(v) && (!q || v.id.toLowerCase().includes(q)))
})

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" })
const date = v => v.releaseTime ? DATE.format(new Date(v.releaseTime)) : ""

function pick(id) {
  if (locked.value || state.busy) return
  setVersion(id)
  emit("close")
}
</script>

<template>
  <Modal :width="440" @close="emit('close')">
    <template #title><h3>Exact game version</h3></template>
    <div class="seg tabs">
      <button v-for="k in KINDS" :key="k.id" :class="{ active: kind === k.id }" @click="kind = k.id">{{ k.label }}</button>
    </div>
    <input v-model="query" placeholder="Filter…" spellcheck="false">

    <div v-if="error" class="err">{{ error }}</div>
    <div v-else-if="!versions.length" class="err">Loading versions…</div>
    <div v-else class="body">
      <div v-for="v in shown" :key="v.id" class="item-row row" :class="{ active: state.version === v.id, off: state.busy || locked }"
        @click="pick(v.id)">
        <span class="nm">{{ v.id }}</span>
        <span v-if="v.id === latest.release || v.id === latest.snapshot" class="tag">latest</span>
        <span class="date">{{ date(v) }}</span>
      </div>
      <div v-if="!shown.length" class="err">No versions match</div>
    </div>
  </Modal>
</template>

<style scoped>
.body { max-height: 50vh; }

.row {
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}

.row:hover .nm { color: var(--accent); }
.row.active .nm { color: var(--green); }
.row.off { cursor: default; opacity: 0.5; }

.tag {
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
}

.date { font-size: 12px; color: var(--text-dim); }
.err { font-size: 13px; color: var(--text-dim); padding: 6px 2px; }
</style>
