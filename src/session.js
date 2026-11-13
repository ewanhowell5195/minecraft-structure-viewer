import { effectScope } from "vue"

const starters = []
let active = null

function run(start) {
  active.scope.run(() => {
    const stop = start(active.signal)
    if (typeof stop === "function") active.stops.push(stop)
  })
}

export function onSession(start) {
  starters.push(start)
  if (active) run(start)
}

export function sessionActive() {
  return active !== null
}

export function sessionSignal() {
  if (!active) throw new Error("session: the viewer isn't running")
  return active.signal
}

export function inSession(run) {
  if (!active) throw new Error("session: the viewer isn't running")
  return active.scope.run(run)
}

export function startSession() {
  if (active) throw new Error("session: the viewer is already running")
  const controller = new AbortController()
  active = { scope: effectScope(true), controller, signal: controller.signal, stops: [] }
  for (const start of starters) run(start)
}

export function stopSession() {
  if (!active) return
  const { scope, controller, stops } = active
  active = null
  for (const stop of stops.reverse()) stop()
  scope.stop()
  controller.abort()
}
