// Usage:  node tools/builtin/extract.js [version]
//   version defaults to the latest snapshot from Mojang's manifest.
//   Requires a JDK (javac/java on PATH or via JAVA_HOME).
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { javaBin, packBundle, prepareVersion, walk, writeBundle } from "./common.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const cache = path.join(here, ".cache")
const log = (...a) => console.log("[builtin]", ...a)

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith("--"))
  const { id, verDir, cp } = await prepareVersion(cache, positional[0], log)
  log("version:", id)

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
  const root = path.resolve(here, "../..")
  writeBundle(path.join(root, "bundled/builtin"), files)
  const count = packBundle(path.join(root, "bundled/builtin"), path.join(root, "public/builtin.zip"))
  log(`wrote bundled/builtin + public/builtin.zip: ${count} files`)
}

main().catch(e => { console.error(e); process.exit(1) })
