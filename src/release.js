const releases = new Map()

export const releaseOf = id => releases.get(id) ?? id

// a version is compared as a release number, so a snapshot counts as the release that followed it in Mojang's list
export function setRelease(id, versions) {
  if (/^\d+\.\d+/.test(id)) return
  let release
  for (const version of versions) {
    if (version.id === id) break
    if (version.type === "release") release = version.id
  }
  if (release) releases.set(id, release)
}
