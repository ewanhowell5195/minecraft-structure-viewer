import * as THREE from "three"
import { getFont, measure, drawText } from "./mcfont.js"

// geometry and magic numbers match the decompiled 26.3 sign renderers; text
// darkens to 40% unless glowing (glowing black outlines with the special 0xF0EBCC)
const TEXT_COLORS = {
  white: 0xffffff, orange: 0xff681f, magenta: 0xff00ff, light_blue: 0x9ac0cd,
  yellow: 0xffff00, lime: 0xbfff00, pink: 0xff69b4, gray: 0x808080,
  light_gray: 0xd3d3d3, cyan: 0x00ffff, purple: 0xa020f0, blue: 0x0000ff,
  brown: 0x8b4513, green: 0x00ff00, red: 0xff0000, black: 0x000000
}

const hex = n => "#" + n.toString(16).padStart(6, "0")
const scaleRGB = (n, f) => hex(
  (Math.floor((n >> 16 & 255) * f) << 16) | (Math.floor((n >> 8 & 255) * f) << 8) | Math.floor((n & 255) * f))

function flat(j) {
  if (j == null) return ""
  if (typeof j === "string") return j
  let s = typeof j.text === "string" ? j.text : ""
  for (const e of j.extra ?? []) s += flat(e)
  return s
}

export function plainText(m) {
  if (typeof m === "string") {
    try { return flat(JSON.parse(m)) } catch { return m }
  }
  return flat(m)
}

function faceData(t) {
  if (!t?.messages) return null
  const lines = Array.from(t.messages).slice(0, 4).map(plainText)
  while (lines.length < 4) lines.push("")
  if (!lines.some(l => l)) return null
  return { lines, color: typeof t.color === "string" ? t.color : "black", glow: !!t.has_glowing_text }
}

function makeFaceCanvas(font, face, LH, MAXW) {
  const S = 4
  const c = document.createElement("canvas")
  c.width = MAXW * S
  c.height = 4 * LH * S
  const ctx = c.getContext("2d")
  const base = TEXT_COLORS[face.color] ?? 0
  const main = face.glow ? hex(base) : scaleRGB(base, 0.4)
  const outline = face.glow ? (base === 0 ? "#f0ebcc" : scaleRGB(base, 0.4)) : null
  for (let i = 0; i < 4; i++) {
    let line = face.lines[i]
    if (!line) continue
    while (line.length > 1 && measure(font, line) > MAXW) line = line.slice(0, -1)
    const x = (c.width - measure(font, line) * S) / 2, y = i * LH * S
    if (outline) {
      for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]])
        drawText(ctx, font, line, x + dx * S, y + dy * S, { scale: S, color: outline })
    }
    drawText(ctx, font, line, x, y, { scale: S, color: main })
  }
  return c
}

const YROT = { south: 0, west: 90, north: 180, east: 270 }
const _m = new THREE.Matrix4()

export async function makeSignTexts(structure) {
  const quads = []
  let font = null
  for (const b of structure.blocks) {
    const e = structure.palette[b.state]
    const name = (e?.Name || "").replace(/^minecraft:/, "")
    const kind = name.match(/(?:^|_)(wall_hanging_sign|hanging_sign|wall_sign|sign)$/)?.[1]
    if (!kind || !b.nbt) continue
    const faces = []
    const front = faceData(b.nbt.front_text), back = faceData(b.nbt.back_text)
    if (front) faces.push({ back: false, ...front })
    if (back) faces.push({ back: true, ...back })
    if (!front && !back && typeof b.nbt.Text1 === "string") {
      const lines = [1, 2, 3, 4].map(i => plainText(b.nbt["Text" + i]))
      if (lines.some(l => l)) faces.push({ back: false, lines, color: typeof b.nbt.Color === "string" ? b.nbt.Color : "black", glow: !!b.nbt.GlowingText })
    }
    if (!faces.length) continue
    try { font ??= await getFont() } catch { return null }
    const hanging = kind.includes("hanging")
    const LH = hanging ? 9 : 10, MAXW = hanging ? 60 : 90
    const s = hanging ? 0.0140625 : 0.010416667
    const p = e.Properties ?? {}
    const yrot = kind === "sign" || kind === "hanging_sign"
      ? (parseInt(p.rotation) || 0) * 22.5
      : YROT[p.facing] ?? 0
    const angle = THREE.MathUtils.degToRad(-yrot)
    for (const f of faces) {
      const M = new THREE.Matrix4().makeTranslation(b.pos[0] * 16 - 8, b.pos[1] * 16 - 8, b.pos[2] * 16 - 8)
      M.multiply(_m.makeScale(16, 16, 16))
      if (hanging) {
        M.multiply(_m.makeTranslation(0.5, 0.9375, 0.5))
        M.multiply(_m.makeRotationY(angle))
        M.multiply(_m.makeTranslation(0, -0.3125, 0))
      } else {
        M.multiply(_m.makeTranslation(0.5, 0.5, 0.5))
        M.multiply(_m.makeRotationY(angle))
        if (kind === "wall_sign") M.multiply(_m.makeTranslation(0, -0.3125, -0.4375))
      }
      if (f.back) M.multiply(_m.makeRotationY(Math.PI))
      M.multiply(_m.makeTranslation(0, hanging ? -0.32 : 0.33333334, hanging ? 0.073 : 0.046666667))
      M.multiply(_m.makeScale(s, s, s))
      quads.push({ canvas: makeFaceCanvas(font, f, LH, MAXW), M, w: MAXW, h: 4 * LH })
    }
  }
  if (!quads.length) return null

  // every text face shares one canvas atlas and one merged mesh
  const area = quads.reduce((a, q) => a + q.canvas.width * q.canvas.height, 0)
  const maxW = Math.max(Math.ceil(Math.sqrt(area)), ...quads.map(q => q.canvas.width))
  let px = 0, py = 0, rowH = 0, aw = 0
  const sorted = Array.from(quads).sort((a, b) => b.canvas.height - a.canvas.height)
  for (const q of sorted) {
    if (px + q.canvas.width > maxW) { px = 0; py += rowH; rowH = 0 }
    q.tx = px
    q.ty = py
    px += q.canvas.width
    rowH = Math.max(rowH, q.canvas.height)
    aw = Math.max(aw, px)
  }
  const atlas = document.createElement("canvas")
  atlas.width = aw
  atlas.height = py + rowH
  const ctx = atlas.getContext("2d")
  const pos = new Float32Array(quads.length * 12)
  const uv = new Float32Array(quads.length * 8)
  const index = new (quads.length * 4 > 65535 ? Uint32Array : Uint16Array)(quads.length * 6)
  const v = new THREE.Vector3()
  quads.forEach((q, i) => {
    ctx.drawImage(q.canvas, q.tx, q.ty)
    const u0 = q.tx / atlas.width, u1 = (q.tx + q.canvas.width) / atlas.width
    const v0 = 1 - (q.ty + q.canvas.height) / atlas.height, v1 = 1 - q.ty / atlas.height
    const corners = [[-q.w / 2, q.h / 2, u0, v1], [q.w / 2, q.h / 2, u1, v1], [-q.w / 2, -q.h / 2, u0, v0], [q.w / 2, -q.h / 2, u1, v0]]
    corners.forEach(([x, y, cu, cv], k) => {
      v.set(x, y, 0).applyMatrix4(q.M)
      pos.set([v.x, v.y, v.z], (i * 4 + k) * 3)
      uv.set([cu, cv], (i * 4 + k) * 2)
    })
    index.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 2, i * 4 + 3, i * 4 + 1], i * 6)
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  const tex = new THREE.CanvasTexture(atlas)
  tex.magFilter = THREE.NearestFilter
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true }))
  mesh.userData.ownsMap = true
  return mesh
}
