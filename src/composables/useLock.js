import { computed, reactive, readonly } from "vue"
import { onSession } from "../session.js"

// withLock locks synchronously before any await so a click in a pre-build async gap can't race
const state = reactive({ depth: 0 })

const locked = computed(() => state.depth > 0)

let generation = 0

function lock(on) {
  state.depth = Math.max(0, state.depth + (on ? 1 : -1))
}

async function withLock(fn) {
  if (locked.value) return
  const gen = generation
  lock(true)
  try {
    return await fn()
  } finally {
    if (gen === generation) lock(false)
  }
}

// a pack stack's loads: busy for its own controls, locked for the rest of the app
async function withBusy(target, fn) {
  const gen = generation
  target.busy = true
  lock(true)
  try {
    return await fn()
  } finally {
    if (gen === generation) {
      target.busy = false
      lock(false)
    }
  }
}

export function useLock() {
  return { locked, lock, withLock, withBusy }
}

onSession(() => {
  generation++
  state.depth = 0
})
