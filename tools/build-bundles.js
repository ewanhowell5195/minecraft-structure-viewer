// Repacks the tracked bundle sources under bundled/ into the public zips,
// the same way BlockModelRenderer's build-assets.js packs assets.zip. The
// extractors regenerate bundled/ and run this packing themselves; run this
// directly after hand editing anything under bundled/.
import path from "node:path"
import { fileURLToPath } from "node:url"
import { packBundle } from "./builtin/common.js"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
for (const name of ["builtin", "features"]) {
  const count = packBundle(path.join(root, "bundled", name), path.join(root, "public", `${name}.zip`))
  console.log(`${name}.zip: ${count} files`)
}
