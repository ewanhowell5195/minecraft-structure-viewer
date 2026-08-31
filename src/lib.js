import * as THREE from "three"

const LIB_URL = "https://cdn.jsdelivr.net/gh/ewanhowell5195/block-model-renderer@master/src/web.js" // TEMP: git, not the npm release

let promise = null

export function loadLibrary() {
  promise ??= import(/* @vite-ignore */ LIB_URL).then(lib => {
    lib.configure({ three: THREE })
    return lib
  })
  return promise
}

export { THREE }
