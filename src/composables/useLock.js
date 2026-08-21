import { computed, reactive, readonly } from "vue"

// withLock locks synchronously before any await so a click in a pre-build async gap can't race
const state = reactive({ depth: 0 })

const locked = computed(() => state.depth > 0)

function lock(on) {
  state.depth = Math.max(0, state.depth + (on ? 1 : -1))
}

async function withLock(fn) {
  if (locked.value) return
  lock(true)
  try {
    return await fn()
  } finally {
    lock(false)
  }
}

// a pack stack's loads: busy for its own controls, locked for the rest of the app
async function withBusy(target, fn) {
  target.busy = true
  lock(true)
  try {
    return await fn()
  } finally {
    target.busy = false
    lock(false)
  }
}

export function useLock() {
  return { locked, lock, withLock, withBusy }
}
