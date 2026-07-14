import { ref } from "vue"

export const tab = ref(new URLSearchParams(location.search).has("feature") ? "features" : "structures")
