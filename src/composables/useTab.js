import { ref } from "vue"

export const tab = ref(new URLSearchParams(location.search).has("feature") ? "features" : "structures")

export const DIFF_TABS = [["new", "New"], ["changed", "Changed"], ["removed", "Removed"]]
export const isDiffTab = t => DIFF_TABS.some(([id]) => id === t)
