import { ref } from "vue"

const supported = document.fullscreenEnabled ?? false
const active = ref(false)
// entering or leaving can cost the pointer lock, which walk mode reads as an exit
let at = 0
const changedAt = () => at
document.addEventListener("fullscreenchange", () => {
  at = performance.now()
  active.value = !!document.fullscreenElement
})

function toggle(el = document.documentElement) {
  if (document.fullscreenElement) document.exitFullscreen()?.catch?.(() => {})
  else el?.requestFullscreen?.()?.catch?.(() => {})
}

export function useFullscreen() {
  return { supported, active, toggle, changedAt }
}
