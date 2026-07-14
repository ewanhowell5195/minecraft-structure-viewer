// Shared plumbing for the game-code extractors (tools/builtin, tools/features):
// version resolution, the download cache, server-bundler classpath extraction,
// the javac/java pipeline helpers, and the bundle dirs the public zips pack
// from (loose files under bundled/ so git tracks the actual contents).
import fs from "node:fs"
import path from "node:path"
import { readZip, unzipEntry, writeZip } from "./zip.js"

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

// replace a bundle dir with the given rel -> bytes map
export function writeBundle(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [rel, bytes] of files) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, bytes)
  }
}

// pack a bundle dir into a zip; sorted entries and a timestamp-free writer
// keep the bytes stable, so the committed zip only churns with real changes
export function packBundle(dir, zipPath) {
  const files = new Map()
  for (const rel of walk(dir).sort()) files.set(rel, fs.readFileSync(path.join(dir, rel)))
  fs.writeFileSync(zipPath, writeZip(files))
  return files.size
}

export async function download(url, dest, log) {
  if (fs.existsSync(dest)) return dest
  log?.("downloading", url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

export async function resolveVersion(requested) {
  const manifest = await (await fetch(MANIFEST)).json()
  const id = requested ?? manifest.latest.snapshot
  const entry = manifest.versions.find(v => v.id === id)
  if (!entry) throw new Error(`unknown version: ${id}`)
  const meta = await (await fetch(entry.url)).json()
  const server = meta.downloads?.server?.url
  if (!server) throw new Error(`version ${id} is missing a server download`)
  return { id, server }
}

// the server jar is a bundler holding the real jar + libraries as entries
export function extractBundler(serverJar, outDir) {
  const files = readZip(fs.readFileSync(serverJar))
  const jars = []
  for (const [entry, e] of files) {
    if (!entry.endsWith(".jar")) continue
    if (!entry.startsWith("META-INF/libraries/") && !entry.startsWith("META-INF/versions/")) continue
    const dest = path.join(outDir, path.basename(entry))
    fs.writeFileSync(dest, unzipEntry(e))
    jars.push(dest)
  }
  if (!jars.length) throw new Error("no jars found in bundler")
  return jars
}

export function javaBin(name) {
  const home = process.env.JAVA_HOME
  return home ? path.join(home, "bin", name) : name
}

export function walk(dir, base = dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) walk(p, base, out)
    else out.push(path.relative(base, p).replaceAll("\\", "/"))
  }
  return out
}

// resolve the version (downloading if uncached) and assemble the classpath
export async function prepareVersion(cache, requestedId, log) {
  let id = requestedId
  if (!id || !fs.existsSync(path.join(cache, id, "server.jar"))) {
    const version = await resolveVersion(id)
    id = version.id
    await download(version.server, path.join(cache, id, "server.jar"), log)
  }
  const verDir = path.join(cache, id)
  const cpDir = path.join(verDir, "cp")
  fs.mkdirSync(cpDir, { recursive: true })
  let classpath = fs.readdirSync(cpDir).filter(f => f.endsWith(".jar")).map(f => path.join(cpDir, f))
  if (!classpath.length) {
    log?.("extracting bundler")
    classpath = extractBundler(path.join(verDir, "server.jar"), cpDir)
  }
  return { id, verDir, cp: classpath.join(path.delimiter) }
}
