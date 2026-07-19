export function queryTerms(query) {
  return query.toLowerCase().split(",").map(t => t.trim().replace(/\s+/g, "_")).filter(Boolean)
}

export function matchIndex(index, query) {
  const terms = queryTerms(query)
  if (!index || !terms.length) return null
  const hit = new Set()
  for (const [key, set] of index) {
    if (!terms.some(t => key.includes(t))) continue
    for (const name of set) hit.add(name)
  }
  return hit
}
