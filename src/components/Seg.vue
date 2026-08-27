<script setup>
defineProps({
  tabs: Array,
  modelValue: null
})
defineEmits(["update:modelValue"])
</script>

<template>
  <div class="seg">
    <button v-for="t in tabs" :key="t.id" :class="{ active: t.id === modelValue }" @click="$emit('update:modelValue', t.id)">{{ t.label }}</button>
  </div>
</template>
