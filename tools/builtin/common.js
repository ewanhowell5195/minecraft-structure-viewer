import fs from "node:fs"
import path from "node:path"
import { readZip, writeZip } from "minecraft-asset-loader"

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

export function writeBundle(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [rel, bytes] of files) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, bytes)
  }
}

// sorted entries + timestamp-free writer keep the zip bytes stable, so it only churns with real changes
export async function packBundle(dir, zipPath) {
  const files = new Map()
  for (const rel of walk(dir).sort()) files.set(rel, fs.readFileSync(path.join(dir, rel)))
  fs.writeFileSync(zipPath, await writeZip(files, { compress: false }))
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
  return { id, server, client: meta.downloads?.client?.url }
}

export async function prepareClient(verDir, id, log) {
  const dest = path.join(verDir, "client.jar")
  if (fs.existsSync(dest)) return dest
  const version = await resolveVersion(id)
  if (!version.client) throw new Error(`version ${id} is missing a client download`)
  return download(version.client, dest, log)
}

// the server jar is a bundler holding the real jar + libraries as entries
export async function extractBundler(serverJar, outDir) {
  const jars = []
  for (const e of readZip(fs.readFileSync(serverJar))) {
    if (!e.path.endsWith(".jar")) continue
    if (!e.path.startsWith("META-INF/libraries/") && !e.path.startsWith("META-INF/versions/")) continue
    const dest = path.join(outDir, path.basename(e.path))
    fs.writeFileSync(dest, await e.read())
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
    classpath = await extractBundler(path.join(verDir, "server.jar"), cpDir)
  }
  return { id, verDir, cp: classpath.join(path.delimiter) }
}
