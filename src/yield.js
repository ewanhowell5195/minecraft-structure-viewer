// setTimeout is throttled in background tabs; scheduler.yield / MessageChannel tasks are not
export const yieldTask = globalThis.scheduler?.yield
  ? () => scheduler.yield()
  : () => new Promise(r => {
    const c = new MessageChannel()
    c.port1.onmessage = () => { c.port1.close(); r() }
    c.port2.postMessage(0)
  })

export function debounce(fn, ms) {
  let timer = null
  const call = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
  call.cancel = () => {
    clearTimeout(timer)
    timer = null
  }
  return call
}
