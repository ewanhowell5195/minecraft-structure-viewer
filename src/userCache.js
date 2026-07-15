// user-provided packs/structure/world files persist like the vanilla jars do
const KEY = "https://sv-user.cache/"
const CACHE = "sv-user-files"
const META = "sv-user-cache"

function meta() {
  try { return JSON.parse(localStorage.getItem(META)) ?? {} } catch { return {} }
}

function setMeta(patch) {
  try { localStorage.setItem(META, JSON.stringify({ ...meta(), ...patch })) } catch {}
}

export async function cacheFile(kind, file) {
  try {
    const c = await caches.open(CACHE)
    await c.put(KEY + kind, new Response(file))
    setMeta({ [kind]: file.name })
  } catch {
    // over quota: drop the stale entry so a reload can't restore the wrong file
    uncache(kind)
  }
}

export async function uncache(kind) {
  try {
    setMeta({ [kind]: null })
    await (await caches.open(CACHE)).delete(KEY + kind)
  } catch {}
}

export async function restoreFile(kind) {
  try {
    const name = meta()[kind]
    if (!name) return null
    const hit = await (await caches.open(CACHE)).match(KEY + kind)
    return hit ? new File([await hit.blob()], name) : null
  } catch { return null }
}

export async function cachePack(file) {
  try {
    await (await caches.open(CACHE)).put(KEY + "pack/" + encodeURIComponent(file.name), new Response(file))
  } catch {}
}

export async function uncachePack(name) {
  try {
    await (await caches.open(CACHE)).delete(KEY + "pack/" + encodeURIComponent(name))
  } catch {}
}

export function setPackOrder(names) {
  setMeta({ packs: names })
}

export async function restorePacks() {
  const out = []
  try {
    const c = await caches.open(CACHE)
    for (const name of meta().packs ?? []) {
      const hit = await c.match(KEY + "pack/" + encodeURIComponent(name))
      if (hit) out.push(new File([await hit.blob()], name))
    }
  } catch {}
  return out
}
