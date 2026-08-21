import { reactive, readonly } from "vue"

const state = reactive({ open: false, x: 0, y: 0, items: [] })

// the row that opened the menu holds its hover styling until the menu closes
let anchor = null
const setAnchor = el => {
  anchor?.classList.remove("ctx-target")
  anchor = el instanceof HTMLElement ? el : null
  anchor?.classList.add("ctx-target")
}

function open(e, items) {
  setAnchor(e.currentTarget)
  state.items = items
  state.x = e.clientX
  state.y = e.clientY
  state.open = true
}

function close() {
  setAnchor(null)
  state.open = false
}

export function useContextMenu() {
  return { state: readonly(state), open, close }
}
