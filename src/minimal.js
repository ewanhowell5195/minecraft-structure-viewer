// ?minimal strips the chrome for embedding: no sidebar, walk button,
// structure-blocks menu, chips, or progress bars; the splash stays up with
// loading status until the first build lands
export const minimal = new URLSearchParams(location.search).has("minimal")

export function fullSiteUrl(href) {
  const u = new URL(href)
  for (const k of ["minimal", "manual", "nosky", "background"]) u.searchParams.delete(k)
  return u.href
}
