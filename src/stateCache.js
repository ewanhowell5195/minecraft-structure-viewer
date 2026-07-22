// persisted per-state computed data (occlusion masks) keyed by the loaded
// source set, so cold builds skip recomputing what a previous session already
// derived from the same packs. Typed arrays survive IndexedDB's structured
// clone, so entries round-trip without serialization.
const DB_NAME = "sv-state-cache"
const STORE = "occlusion"
const MAX_RECORDS = 8

let dbPromise = null
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

export async function loadStateCache(key) {
  try {
    const d = await db()
    const rec = await new Promise((resolve, reject) => {
      const rq = d.transaction(STORE).objectStore(STORE).get(key)
      rq.onsuccess = () => resolve(rq.result ?? null)
      rq.onerror = () => reject(rq.error)
    })
    return Array.isArray(rec?.entries) ? rec.entries : null
  } catch {
    return null
  }
}

export async function saveStateCache(key, entries) {
  try {
    const d = await db()
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put({ entries, savedAt: Date.now() }, key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    const keys = await new Promise((resolve, reject) => {
      const rq = d.transaction(STORE).objectStore(STORE).getAllKeys()
      rq.onsuccess = () => resolve(rq.result)
      rq.onerror = () => reject(rq.error)
    })
    if (keys.length > MAX_RECORDS) {
      const stamped = []
      for (const k of keys) {
        const rec = await new Promise(resolve => {
          const rq = d.transaction(STORE).objectStore(STORE).get(k)
          rq.onsuccess = () => resolve(rq.result)
          rq.onerror = () => resolve(null)
        })
        stamped.push([k, rec?.savedAt ?? 0])
      }
      stamped.sort((a, b) => a[1] - b[1])
      for (const [k] of stamped.slice(0, keys.length - MAX_RECORDS)) {
        await new Promise(resolve => {
          const tx = d.transaction(STORE, "readwrite")
          tx.objectStore(STORE).delete(k)
          tx.oncomplete = resolve
          tx.onerror = resolve
        })
      }
    }
  } catch {}
}
