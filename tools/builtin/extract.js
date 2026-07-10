// Extracts the game's hardcoded structures into .nbt files and bundles them
// as public/builtin.zip. Mirrors the library's tools/generate pipeline: the
// unobfuscated server jar is downloaded, BuiltinExtract.java is compiled with
// javac against it and run with a capturing world.
//
// Usage:  node tools/builtin/extract.js [version]
//   version defaults to the latest snapshot from Mojang's manifest.
//   Requires a JDK (javac/java on PATH or via JAVA_HOME).
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readZip, unzipEntry, writeZip } from "./zip.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const cache = path.join(here, ".cache")
const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const log = (...a) => console.log("[builtin]", ...a)

async function download(url, dest) {
  if (fs.existsSync(dest)) return dest
  log("downloading", url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

async function resolveVersion(requested) {
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
function extractBundler(serverJar, outDir) {
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

function javaBin(name) {
  const home = process.env.JAVA_HOME
  return home ? path.join(home, "bin", name) : name
}

function walk(dir, base = dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) walk(p, base, out)
    else out.push(path.relative(base, p).replaceAll("\\", "/"))
  }
  return out
}

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith("--"))
  let id = positional[0]
  // an already-cached version can run offline
  if (!id || !fs.existsSync(path.join(cache, id, "server.jar"))) {
    const version = await resolveVersion(id)
    id = version.id
    await download(version.server, path.join(cache, id, "server.jar"))
  }
  log("version:", id)
  const verDir = path.join(cache, id)
  const cpDir = path.join(verDir, "cp")
  fs.mkdirSync(cpDir, { recursive: true })

  let classpath = fs.readdirSync(cpDir).filter(f => f.endsWith(".jar")).map(f => path.join(cpDir, f))
  if (!classpath.length) {
    log("extracting bundler")
    classpath = extractBundler(path.join(verDir, "server.jar"), cpDir)
  }
  const cp = classpath.join(path.delimiter)

  const classesDir = path.join(verDir, "builtin-classes")
  fs.rmSync(classesDir, { recursive: true, force: true })
  fs.mkdirSync(classesDir, { recursive: true })
  log("compiling BuiltinExtract.java")
  execFileSync(javaBin("javac"), ["-cp", cp, "-nowarn", "-d", classesDir, path.join(here, "BuiltinExtract.java")], { stdio: "inherit", cwd: verDir })

  const outDir = path.join(verDir, "out")
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  log("running extractor")
  execFileSync(javaBin("java"), ["-cp", `${cp}${path.delimiter}${classesDir}`, "BuiltinExtract", outDir], { stdio: "inherit", cwd: verDir })

  const files = new Map()
  for (const rel of walk(outDir).sort()) files.set(rel, fs.readFileSync(path.join(outDir, rel)))
  const zipPath = path.resolve(here, "../../public/builtin.zip")
  fs.writeFileSync(zipPath, writeZip(files))
  log(`wrote ${path.relative(path.resolve(here, "../.."), zipPath)}: ${files.size} structures`)
}

main().catch(e => { console.error(e); process.exit(1) })
