<script setup>
defineProps({
  width: { type: Number, required: true },
  z: { type: Number, default: 100 },
  closable: { type: Boolean, default: true },
  dismissable: { type: Boolean, default: true }
})
const emit = defineEmits(["close"])
</script>

<template>
  <div class="modal-backdrop" :style="{ zIndex: z }" @pointerdown.self="dismissable && emit('close')">
    <div class="modal-panel" :style="{ width: width + 'px' }">
      <header v-if="$slots.title || $slots.controls || closable">
        <div class="titles">
          <slot name="title" />
        </div>
        <div class="controls">
          <slot name="controls" />
          <button v-if="closable" class="icon" title="Close" @click="emit('close')">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </header>
      <slot />
    </div>
  </div>
</template>
