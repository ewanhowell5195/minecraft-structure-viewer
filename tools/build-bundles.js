// Usage:  node tools/build-bundles.js
//   repacks bundled/ into the public zips; run after hand editing anything under bundled/
import path from "node:path"
import { fileURLToPath } from "node:url"
import { packBundle } from "./builtin/common.js"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
for (const name of ["builtin", "features"]) {
  const count = packBundle(path.join(root, "bundled", name), path.join(root, "public", `${name}.zip`))
  console.log(`${name}.zip: ${count} files`)
}
