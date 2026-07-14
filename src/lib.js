import * as THREE from "three"

// the app hands its three instance over so only one copy of three ever exists
const LIB_URL = "https://cdn.jsdelivr.net/npm/block-model-renderer/src/web.js"

let promise = null

export function loadLibrary() {
  promise ??= import(/* @vite-ignore */ LIB_URL).then(lib => {
    lib.configure({ three: THREE })
    return lib
  })
  return promise
}

export { THREE }
