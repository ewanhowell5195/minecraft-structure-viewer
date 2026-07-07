import { loadLibrary } from "./lib.js"
import { usePacks } from "./composables/usePacks.js"

// the minecraft font, straight from the pack's ascii.png: 16x16 grid of
// glyph cells, advance widths scanned from the alpha channel the way the
// game does (space is half a cell). re-read when the packs change
let fontPromise = null, fontVersion = -1

export async function getFont() {
  const packs = usePacks()
  const v = packs.state.assetsVersion
  if (fontPromise && v === fontVersion) return fontPromise
  fontVersion = v
  return fontPromise = (async () => {
    const lib = await loadLibrary()
    const buf = await lib.readFile("assets/minecraft/textures/font/ascii.png", packs.assets.value)
    const img = await createImageBitmap(new Blob([buf], { type: "image/png" }))
    const c = document.createElement("canvas")
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext("2d")
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    const cw = c.width / 16, ch = c.height / 16
    const widths = []
    for (let i = 0; i < 256; i++) {
      const gx = (i % 16) * cw, gy = (i / 16 | 0) * ch
      let wpx = 0
      for (let px = cw - 1; px >= 0 && !wpx; px--)
        for (let py = 0; py < ch; py++)
          if (data[((gy + py) * c.width + gx + px) * 4 + 3]) { wpx = px + 1; break }
      widths[i] = i === 32 ? cw / 2 : wpx
    }
    return { canvas: c, cw, ch, widths }
  })()
}

// glyphs outside the sheet (or with no pixels) fall back to "?"
const codeOf = (font, g) => {
  const n = g.codePointAt(0)
  return n < 256 && (font.widths[n] || n === 32) ? n : 63
}

export function measure(font, text) {
  let w = 0
  for (const g of [...text]) w += font.widths[codeOf(font, g)] + 1
  return Math.max(0, w - 1)
}

// glyphs are white in the sheet; a color tints them via an offscreen pass
export function drawText(ctx, font, text, x, y, { scale = 1, color } = {}) {
  const w = Math.ceil(measure(font, text) * scale), h = Math.ceil(font.ch * scale)
  if (!w) return 0
  let target = ctx, dx = x, dy = y, off = null
  if (color) {
    off = document.createElement("canvas")
    off.width = w
    off.height = h
    target = off.getContext("2d")
    dx = 0
    dy = 0
  }
  target.imageSmoothingEnabled = false
  for (const g of [...text]) {
    const n = codeOf(font, g)
    target.drawImage(font.canvas, (n % 16) * font.cw, (n / 16 | 0) * font.ch, font.cw, font.ch, dx, dy, font.cw * scale, font.ch * scale)
    dx += (font.widths[n] + 1) * scale
  }
  if (off) {
    target.globalCompositeOperation = "source-in"
    target.fillStyle = color
    target.fillRect(0, 0, w, h)
    ctx.drawImage(off, x, y)
  }
  return w
}
