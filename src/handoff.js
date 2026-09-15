// an embed is cross-site, so its storage is partitioned away from the full
// site's tab; the files it is showing travel over postMessage to the tab it opens
const MARK = "structure-viewer-handoff"

export function offerHandoff(getFiles) {
  addEventListener("message", async e => {
    if (e.origin !== location.origin || e.data?.[MARK] !== "ready") return
    const files = {}
    const transfer = []
    for (const [kind, file] of Object.entries(getFiles())) {
      if (!file) continue
      const bytes = await file.arrayBuffer()
      files[kind] = { name: file.name, bytes }
      transfer.push(bytes)
    }
    e.source.postMessage({ [MARK]: "files", files }, e.origin, transfer)
  })
}

export function receiveHandoff(timeout = 3000) {
  return new Promise(resolve => {
    if (!opener) return resolve(null)
    const timer = setTimeout(done, timeout, null)
    function onMessage(e) {
      if (e.origin !== location.origin || e.data?.[MARK] !== "files") return
      const out = {}
      for (const [kind, { name, bytes }] of Object.entries(e.data.files)) out[kind] = new File([bytes], name)
      done(out)
    }
    function done(v) {
      clearTimeout(timer)
      removeEventListener("message", onMessage)
      resolve(v)
    }
    addEventListener("message", onMessage)
    opener.postMessage({ [MARK]: "ready" }, location.origin)
  })
}
