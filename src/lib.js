import * as THREE from "three"

const LIB_URL = "https://cdn.jsdelivr.net/gh/ewanhowell5195/block-model-renderer@687ac134cd0afe28e09e0422ffc3f984940ea37c/src/web.js"

let promise = null

export function loadLibrary() {
  promise ??= import(/* @vite-ignore */ LIB_URL).then(lib => {
    lib.configure({ three: THREE })
    return lib
  })
  return promise
}

export { THREE }
