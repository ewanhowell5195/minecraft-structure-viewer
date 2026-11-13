import { ref } from "vue"
import { onSession } from "../session.js"

export const tab = ref("structures")

export const DIFF_TABS = [["new", "New"], ["changed", "Changed"], ["removed", "Removed"]]
export const isDiffTab = t => DIFF_TABS.some(([id]) => id === t)

onSession(() => {
  tab.value = new URLSearchParams(location.search).has("feature") ? "features" : "structures"
})
