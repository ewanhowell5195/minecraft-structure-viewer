import * as THREE from "three"

// The library is loaded at runtime from jsDelivr, tracking the latest-v2
// branch: an alias of v2, pushed alongside it, because jsdelivr reads "@v2"
// as a semver range rather than a branch. VITE_LIB_URL overrides (e.g. a
// localhost dev server). The app owns the three instance and hands it over,
// so there is only ever one copy of three.
const LIB_URL = import.meta.env.VITE_LIB_URL ?? "https://cdn.jsdelivr.net/gh/ewanhowell5195/block-model-renderer@latest-v2/src/web.js"

let promise = null

export function loadLibrary() {
  promise ??= import(/* @vite-ignore */ LIB_URL).then(lib => {
    lib.configure({ three: THREE })
    return lib
  })
  return promise
}

export { THREE }
