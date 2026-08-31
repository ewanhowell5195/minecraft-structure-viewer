// both file inputs accept the same things and send each file where it belongs,
// so it does not matter which one it was dropped on
import { loadLibrary } from "./lib.js"
import { zipKind } from "./loosezip.js"
import { usePacks } from "./composables/usePacks.js"
import { useWorld } from "./composables/useWorld.js"
import { useStructure } from "./composables/useStructure.js"
import { useCompare } from "./composables/useCompare.js"

export const FILE_ACCEPT = ".nbt,.litematic,.schem,.schematic,.mcstructure,.zip,.jar,.mcpack,.mcaddon,.mcworld,.mca"

const STRUCT_EXT = /\.(nbt|mcstructure|litematic|schem|schematic)$/i
const ARCHIVE_EXT = /\.(zip|jar|mcpack|mcaddon|mcworld)$/i

export async function classifyFile(file) {
  if (/\.mca$/i.test(file.name)) return "world"
  if (STRUCT_EXT.test(file.name)) return "structure"
  if (!ARCHIVE_EXT.test(file.name)) return "structure"
  const lib = await loadLibrary()
  let keys
  try {
    keys = Array.from(lib.parseZip(new Uint8Array(await file.arrayBuffer())).keys())
  } catch {
    return "structure"
  }
  return keys.length ? zipKind(keys) : "structure"
}

function openStructure(file) {
  const compare = useCompare()
  if (compare.versionArmed()) compare.setMainFile(file)
  else useStructure().loadFile(file)
}

export async function routeFiles(files) {
  const sources = []
  for (const file of files) {
    const kind = await classifyFile(file)
    if (kind === "world") useWorld().openWorld(file)
    else if (kind === "structure") openStructure(file)
    else sources.push(file)
  }
  if (sources.length) await usePacks().addPacks(sources)
}
