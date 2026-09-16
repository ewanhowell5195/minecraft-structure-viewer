<script setup>
import { computed, ref } from "vue"
import { useBuild, DEFAULT_DAYTIME } from "../composables/useBuild.js"
import { useLock } from "../composables/useLock.js"
import { useSky } from "../composables/useSky.js"

const { state: buildState } = useBuild()
const { locked } = useLock()
const { enabled: sky, dimension: skyDimension, lightDim } = useSky()
const collapsed = ref(false)

const lighting = computed({
  get: () => buildState.lighting === "world",
  set: v => { buildState.lighting = v ? "world" : "off" }
})

// a typed time wraps like the game's, so 24000 is midnight again
function setDaytime(input) {
  const n = Math.round(Number(input.value))
  if (input.value !== "" && Number.isFinite(n)) buildState.daytime = ((n % 24000) + 24000) % 24000
  input.value = buildState.daytime
}
</script>

<template>
  <section :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      Environment
    </h2>
    <div class="checks">
      <label class="check">
        <input type="checkbox" v-model="lighting" :disabled="locked">
        Lighting
      </label>
      <label v-if="buildState.lighting === 'world'" class="check">
        <input type="checkbox" v-model="buildState.fullbright" :disabled="locked">
        Fullbright
      </label>
      <label class="check" title="The game's sky, sun, moon and stars. Always on while walking">
        <input type="checkbox" v-model="sky">
        Sky
      </label>
      <label v-if="sky" class="check dim" title="Auto follows the structure's own dimension">
        Dimension
        <select v-model="skyDimension" :disabled="locked">
          <option value="auto">Auto</option>
          <option value="overworld">Overworld</option>
          <option value="the_nether">Nether</option>
          <option value="the_end">The End</option>
        </select>
      </label>
      <label v-if="buildState.lighting === 'world' && !buildState.fullbright && lightDim === 'overworld'" class="check daytime">
        Daytime
        <input type="range" min="0" max="23999" v-model.number="buildState.daytime">
        <input type="number" class="value" min="0" max="23999" :value="buildState.daytime"
          @change="setDaytime($event.target)" @keydown.enter="$event.target.blur()">
        <button class="reset" title="Reset daytime" :disabled="buildState.daytime === DEFAULT_DAYTIME" @click.prevent="buildState.daytime = DEFAULT_DAYTIME">
          <span class="material-symbols-outlined">restart_alt</span>
        </button>
      </label>
    </div>
  </section>
</template>

<style scoped>
.dim select { flex: 1; }

.daytime { min-width: 0; }

.daytime input[type="range"] {
  flex: 1;
  min-width: 0;
}

.daytime .value {
  flex: none;
  width: 6ch;
  padding: 0;
  border: none;
  background: none;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--text-dim);
  -moz-appearance: textfield;
}

.daytime .value:focus {
  color: var(--text);
  outline: none;
}

.daytime .value::-webkit-outer-spin-button,
.daytime .value::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.daytime .reset {
  flex: none;
  padding: 2px;
}

.daytime .reset:disabled {
  opacity: 0.35;
  cursor: default;
}

.daytime .reset .material-symbols-outlined { font-size: 16px; }
</style>
