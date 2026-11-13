import { routerHistory, pathOf } from "./history.js"
import { sessionActive } from "./session.js"

// null, undefined and false drop the param; true writes "1"
export function paramUrl(changes) {
  const u = new URL(location)
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === false) u.searchParams.delete(k)
    else u.searchParams.set(k, v === true ? "1" : String(v))
  }
  return u
}

export const setParams = changes => writeUrl(paramUrl(changes))
export const pushParams = changes => writeUrl(paramUrl(changes), true)

export function writeUrl(url, push = false) {
  if (!sessionActive()) return
  if (push) routerHistory.push(pathOf(url))
  else routerHistory.replace(pathOf(url))
}
