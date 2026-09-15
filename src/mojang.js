import MinecraftAssets from "minecraft-asset-loader"

export const assets = new MinecraftAssets()

export async function listVersions() {
  const [versions, latest] = await Promise.all([assets.manifest.versions(), assets.manifest.latest()])
  return {
    latest: { release: latest.release?.id, snapshot: latest.newest?.id },
    versions: versions.map(v => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }))
  }
}

// the snapshot channel is the newest build of either kind, as the launcher's is
export async function loadMojangJar(channel = "release", onProgress, version) {
  const id = version || (await assets.manifest.latest())[channel === "snapshot" ? "newest" : "release"]?.id
  const ver = id && await assets.manifest.version(id)
  if (!ver) throw new Error(`version not found: ${version || channel}`)
  await assets.loadJar({ version: ver.id, onProgress: (done, total) => onProgress?.(done, total ?? 0, ver.id) })
  return { id: ver.id, channel, type: ver.type, bytes: await assets.export({ version: ver.id }) }
}
