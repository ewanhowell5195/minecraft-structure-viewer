import * as THREE from "three"

const LIB_URL = "https://cdn.jsdelivr.net/npm/block-model-renderer/dist/block-model-renderer.min.js"

let promise = null

export function loadLibrary() {
  promise ??= import(/* @vite-ignore */ LIB_URL).then(lib => {
    lib.configure({ three: THREE })
    return lib
  })
  return promise
}

export { THREE }
