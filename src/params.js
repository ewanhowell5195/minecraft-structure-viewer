// null, undefined and false drop the param; true writes "1"
export function paramUrl(changes) {
  const u = new URL(location)
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === false) u.searchParams.delete(k)
    else u.searchParams.set(k, v === true ? "1" : String(v))
  }
  return u
}

export const setParams = changes => history.replaceState(null, "", paramUrl(changes))
export const pushParams = changes => history.pushState(null, "", paramUrl(changes))
