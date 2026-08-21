<script setup>
import { ref } from "vue"
import { usePacks } from "../composables/usePacks.js"
import PackStack from "./PackStack.vue"

const { state, setChannel, addPacks, removePack, movePack } = usePacks()
const collapsed = ref(false)
</script>

<template>
  <section :class="{ collapsed }">
    <h2 @click="collapsed = !collapsed">
      <span class="material-symbols-outlined chev">{{ collapsed ? "chevron_right" : "expand_more" }}</span>
      Packs
    </h2>
    <PackStack :state="state" @channel="setChannel" @add="addPacks" @move="movePack" @remove="removePack" />
  </section>
</template>
