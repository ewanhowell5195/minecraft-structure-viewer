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

export function useLock() {
  return { locked, lock, withLock }
}
