import { reactive, readonly } from "vue"

// One app-wide context menu: callers hand over the items to show at the
// pointer, ContextMenu.vue renders and dismisses it.
// items: [{ label, icon?, disabled?, action }]
const state = reactive({ open: false, x: 0, y: 0, items: [] })

function open(e, items) {
  state.items = items
  state.x = e.clientX
  state.y = e.clientY
  state.open = true
}

function close() {
  state.open = false
}

export function useContextMenu() {
  return { state: readonly(state), open, close }
}
