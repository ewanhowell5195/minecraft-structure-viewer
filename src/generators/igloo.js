import { rnd } from "../transforms.js"
import { combine } from "../combine.js"

// igloo (IglooPieces): the top, plus a ladder shaft down to a basement lab.
// three parts, so three step-levels: top (0), the ladder shaft (1), the lab at
// its bottom (2). vanilla only rolls the basement 50% of the time, but here the
// bare top is just the plain igloo you can already load, so we always build the
// basement: otherwise the session would have nothing to step to. offsets from
// the decompiled source; ladder length N=4-11 stays random
export async function runIgloo(loadStruct, { maxDepth = Infinity, seed } = {}) {
  const rand = seed == null ? Math.random : rnd(seed)
  const top = await loadStruct("igloo/top")
  if (!top) return { structure: combine([]), maxDepth: 0 }
  const pieces = [{ struct: top, rot: 0, off: [0, 0, 0], depth: 0 }]
  const d = Math.floor(rand() * 8) + 4
  const bottom = await loadStruct("igloo/bottom"), middle = await loadStruct("igloo/middle")
  for (let i = 0; i < d - 1 && middle; i++) pieces.push({ struct: middle, rot: 0, off: [2, -3 - i * 3, 4], depth: 1 })
  if (bottom) pieces.push({ struct: bottom, rot: 0, off: [0, -3 - d * 3, -2], depth: 2 })
  // igloo pieces use the STRUCTURE_BLOCK processor => air carves (ladder shaft)
  return { structure: combine(pieces.filter(p => p.depth <= maxDepth).map(p => ({ ...p, ow: true }))), maxDepth: 2 }
}
