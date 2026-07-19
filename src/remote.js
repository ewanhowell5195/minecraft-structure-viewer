export const CORS_PROXY = "https://cors.ewanhowell.com/"

export const isRemote = s => /^https?:\/\//i.test(s)

export function remoteName(url) {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? ""
    return decodeURIComponent(last) || url
  } catch {
    return url
  }
}

// starts downloads without a consumer yet (structure bytes don't need the
// assets, so they can race the jar); fetchRemote picks them up, consume-once
const prefetched = new Map()

export function prefetchRemote(urls) {
  for (const url of urls) {
    if (prefetched.has(url)) continue
    const p = proxyFetch(url)
    p.catch(() => {})
    prefetched.set(url, p)
  }
}

export function fetchRemote(url) {
  const p = prefetched.get(url)
  if (p) {
    prefetched.delete(url)
    return p
  }
  return proxyFetch(url)
}

export async function proxyFetch(url, onProgress) {
  const res = await fetch(CORS_PROXY + url)
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  if (!onProgress || !res.body) return new Uint8Array(await res.arrayBuffer())
  const total = Number(res.headers.get("Content-Length")) || 0
  const reader = res.body.getReader()
  const chunks = []
  let got = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onProgress(got, total)
  }
  const out = new Uint8Array(got)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
