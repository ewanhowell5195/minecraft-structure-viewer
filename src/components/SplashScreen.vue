<script setup>
// single splash/loading screen: the minimal-mode landing state, load progress,
// and the stream "preparing world" screen all render through this with
// different configs (see the `splash` computed in App.vue)
defineProps({
  title: { type: String, default: "Structure Viewer" },
  blurb: Boolean,
  name: { type: String, default: "" },
  error: { type: String, default: "" },
  spinner: Boolean,
  status: { type: String, default: "" },
  note: { type: String, default: "" },
  link: { type: Object, default: null },
  cancel: Boolean
})
defineEmits(["cancel", "linkdown"])
</script>

<template>
  <div class="splash-overlay">
    <h1>{{ title }}</h1>
    <p v-if="error" class="splash-error">{{ error }}</p>
    <p v-if="name" class="splash-name">Opening: {{ name }}</p>
    <template v-if="blurb">
      <p>View every Minecraft structure and worldgen feature in 3D, from village pieces to whole strongholds and trees to geodes, and test out how they generate with re-rollable seeds.</p>
      <p>Load your own structures and world saves, apply resource packs, mods, and datapacks, combine structures into one scene, and share anything with a link.</p>
    </template>
    <svg v-if="spinner" class="spinner" viewBox="0 0 24 24" width="30" height="30" aria-label="Loading">
      <circle cx="12" cy="12" r="10" fill="none" stroke="#ffffff1f" stroke-width="3"/>
      <path d="M12 2 a 10 10 0 0 1 10 10" fill="none" stroke="#4c8dff" stroke-width="3" stroke-linecap="round"/>
    </svg>
    <p v-if="status" class="splash-status">{{ status }}</p>
    <p v-if="note" class="splash-note">{{ note }}</p>
    <a v-if="link" class="splash-link" :href="link.href" target="_blank" rel="noopener" @pointerdown="$emit('linkdown')">{{ link.label }}</a>
    <button v-if="cancel" class="splash-cancel" @click="$emit('cancel')">Cancel</button>
  </div>
</template>

<style scoped>
.splash-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  background: var(--bg);
  color: #9a9aa5;
  text-align: center;
}

h1 {
  margin: 0;
  font-size: 34px;
  color: #e8e8ec;
}

p {
  margin: 0;
  max-width: 560px;
  line-height: 1.6;
}

.spinner {
  margin-top: 10px;
  animation: spin 0.9s linear infinite;
}

.splash-name {
  color: #c9c9d2;
}

.splash-error {
  color: var(--red);
}

.splash-link {
  margin-top: 10px;
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  text-decoration: none;
}

.splash-link:hover { background: #2e2e36; }

.splash-cancel {
  margin-top: 6px;
}

.splash-status {
  font-size: 13px;
  color: #6f6f7a;
  font-variant-numeric: tabular-nums;
}

.splash-note {
  font-size: 12px;
  color: #6f6f7a;
  max-width: 420px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
