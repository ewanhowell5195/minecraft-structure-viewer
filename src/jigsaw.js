import { DIR, EMPTY, OPP, boxHit, inBox, jigsawsOf, pieceBox, poolTemplates, rnd, rotDir, rotPos, shuffle, worldJigsaw } from "./transforms.js"
import { combine } from "./combine.js"

// level d rolls its own rng seeded levelSeed(d + 1), so re-running with a deeper maxDepth reproduces every earlier level exactly

const nsName = s => s.includes(":") ? s : "minecraft:" + s

const inRegion = (b, r) =>
  b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1 && b.z0 >= r.z0 && b.z1 <= r.z1

export async function runJigsaw(start, { loadStruct, loadPool, loadFeature, maxDepth = 6, maxPieces = 48, maxRadius = 96, levelSeed, onProgress, keepJigsaws = true }) {
  const structs = new Map(), pools = new Map()
  async function getStruct(ref) {
    if (!structs.has(ref)) structs.set(ref, await Promise.resolve(loadStruct(ref)).catch(() => null))
    return structs.get(ref)
  }
  async function getPool(ref) {
    if (!pools.has(ref)) pools.set(ref, await Promise.resolve(loadPool(ref)).catch(() => null))
    return pools.get(ref)
  }

  const startPiece = { struct: start, rot: 0, off: [0, 0, 0], depth: 0, box: pieceBox(start, 0, [0, 0, 0]) }
  startPiece.free = { region: null, used: [startPiece.box] }
  const pieces = [startPiece]
  let frontier = [startPiece]
  let exhausted = false

  // the d === maxDepth iteration is a rolled-back look-ahead: it only answers
  // "is anything left", so the level menu can stop AT the last real level
  for (let d = 0; d <= maxDepth && frontier.length && pieces.length < maxPieces; d++) {
    const probe = d === maxDepth
    const mark = probe && { pieces: pieces.length, taken: [] }
    const rand = rnd(levelSeed(d + 1))
    const next = []
    for (const src of frontier) {
      if (pieces.length >= maxPieces) break
      for (const j of jigsawsOf(src.struct)) {
        if (pieces.length >= maxPieces) break
        const wj = worldJigsaw(j, src)
        if (!wj.pool) continue
        const pool = await getPool(wj.pool)
        if (!pool) continue
        const dir = DIR[wj.front]
        const targetPos = [wj.pos[0] + dir[0], wj.pos[1] + dir[1], wj.pos[2] + dir[2]]
        // vanilla: a child inside the source box takes space from the source's own
        // interior, anything else from the space the source itself was placed in
        const free = inBox(targetPos, src.box) ? (src.inner ??= { region: src.box, used: [] }) : src.free
        let candidates = shuffle(poolTemplates(pool), rand)
        if (typeof pool.fallback === "string") {
          const fb = await getPool(pool.fallback)
          if (fb) candidates = candidates.concat(shuffle(poolTemplates(fb), rand))
        }
        const place = (struct, k, off, feature = false, box = pieceBox(struct, k, off)) => {
          if (Math.hypot((box.x0 + box.x1) / 2, (box.z0 + box.z1) / 2) > maxRadius) return false
          if (free.region && !inRegion(box, free.region)) return false
          if (free.used.some(b => boxHit(box, b))) return false
          const piece = { struct, rot: k, off, depth: d + 1, box, free, feature }
          pieces.push(piece)
          free.used.push(box)
          if (probe) mark.taken.push(free)
          next.push(piece)
          if (!probe) onProgress?.(pieces.length)
          return true
        }

        const tried = new Set()
        jig: for (const loc of candidates) {
          if (loc === EMPTY) break // empty_pool_element won the roll: place nothing
          const key = typeof loc === "string" ? loc : loc.feature
          if (tried.has(key)) continue
          tried.add(key)
          // feature_pool_element: the game gives it one jigsaw at the feature origin
          // facing down, so it only joins an upward-facing one, and since
          // 26.3-snapshot-6 that jigsaw takes whatever name the parent targets
          if (typeof loc !== "string") {
            if (!loadFeature || wj.front !== "up") continue
            const feat = await loadFeature(loc.feature, Math.floor(rand() * 0x7fffffff)).catch(() => null)
            if (!feat?.blocks?.length) continue
            const org = feat.origin ?? [0, 0, 0]
            const [tx, ty, tz] = targetPos
            const box = { x0: tx, y0: ty, z0: tz, x1: tx + 1, y1: ty + 1, z1: tz + 1 }
            if (place(feat, 0, [tx - org[0], ty - org[1], tz - org[2]], true, box)) break jig
            continue
          }
          const child = await getStruct(loc)
          if (!child) continue
          const childJigs = jigsawsOf(child)
          for (const k of shuffle([0, 1, 2, 3], rand)) {
            for (const cj of childJigs) {
              if (wj.front !== OPP[rotDir(cj.front, k)]) continue
              if (wj.joint !== "rollable" && wj.top !== rotDir(cj.top, k)) continue
              if (nsName(wj.target) !== nsName(cj.name)) continue
              const cp = rotPos(cj.pos, k)
              const off = [targetPos[0] - cp[0], targetPos[1] - cp[1], targetPos[2] - cp[2]]
              if (place(child, k, off)) break jig
            }
          }
        }
      }
    }
    if (probe) {
      exhausted = !next.length
      pieces.length = mark.pieces
      while (mark.taken.length) mark.taken.pop().used.pop()
      break
    }
    if (!next.length) { exhausted = true; break }
    frontier = next
  }
  // exhausted = the graph ran dry, as opposed to hitting the piece cap
  let depth = 0
  for (const p of pieces) if (p.depth > depth) depth = p.depth
  exhausted = exhausted && pieces.length < maxPieces
  // vanilla only swaps a jigsaw block for its final_state once it has RUN;
  // the final level's unrun jigsaws stay visible while more can still load
  if (!exhausted && keepJigsaws) for (const p of pieces) if (p.depth === depth) p.keepJigsaws = true
  return { structure: combine(pieces), pieces: pieces.length, depth, exhausted, capped: pieces.length >= maxPieces }
}
