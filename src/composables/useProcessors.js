import { reactive, readonly } from "vue"
import { setParams } from "../params.js"
import { mix, rand32 } from "../transforms.js"
import { seedFor } from "../processors.js"

const sp = new URLSearchParams(location.search)
const parseSeed = v => /^[0-9a-f]{1,8}$/i.test(v ?? "") ? parseInt(v, 16) >>> 0 : null

const state = reactive({
  on: sp.get("proc") !== "0",
  seed: parseSeed(sp.get("pseed"))
})

// an unshuffled roll stays on the structure's own seed, so the default render
// matches the game's
const seedOf = rel => state.seed == null ? seedFor(rel) : mix(state.seed, seedFor(rel))

let reload = null
const setReloadHandler = fn => { reload = fn }

function sync() {
  setParams({
    proc: state.on ? null : "0",
    pseed: state.seed == null ? null : state.seed.toString(16)
  })
}

async function setOn(on) {
  if (on === state.on) return
  state.on = on
  // a roll means nothing with the processors off
  if (!on) state.seed = null
  sync()
  await reload?.()
}

async function shuffle() {
  state.seed = rand32()
  sync()
  if (state.on) await reload?.()
}

export function useProcessors() {
  return { state: readonly(state), seedOf, setOn, shuffle, setReloadHandler }
}
