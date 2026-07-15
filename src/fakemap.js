import { getFont, measure, drawText } from "./mcfont.js"

// stand-in map art (the real pixels live in the world save's data/map_<id>.dat);
// sampling a shared noise field by wall-plane coords lets adjacent frames stitch
function hash(x, y) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}

const smooth = t => t * t * (3 - 2 * t)

function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y)
  const fx = x - xi, fy = y - yi
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
  const u = smooth(fx), v = smooth(fy)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

const fbm = (x, y) =>
  noise(x / 96, y / 96) * 0.55 +
  noise(x / 37 + 100.7, y / 37 + 31.1) * 0.3 +
  noise(x / 13 + 517.3, y / 13 + 209.4) * 0.15

// vanilla map palette; shading multipliers are the game's map brightness levels
// vanilla map palette; the three multipliers are the game's map shading levels
const SHADES = [0.706, 0.863, 1]
const WATER = [64, 64, 255], SAND = [247, 233, 163], GRASS = [127, 178, 56]
const FOREST = [0, 124, 0], STONE = [112, 112, 112], SNOW = [255, 255, 255]

function colourAt(u, v) {
  const h = fbm(u, v)
  if (h < 0.49) return [WATER, h < 0.36 ? 0.706 : h < 0.44 ? 0.863 : 1]
  const base = h < 0.52 ? SAND : h < 0.66 ? GRASS : h < 0.78 ? FOREST : h < 0.86 ? STONE : SNOW
  const d = noise(u / 7 + 913.7, v / 7 + 41.9)
  return [base, SHADES[d < 0.2 ? 0 : d < 0.62 ? 1 : 2]]
}

export async function drawFakeMap(canvas, sample, id) {
  const ctx = canvas.getContext("2d")
  const img = ctx.createImageData(128, 128)
  const px = img.data
  for (let cy = 0; cy < 128; cy++) {
    for (let cx = 0; cx < 128; cx++) {
      const [u, v] = sample(cx, cy)
      const [rgb, shade] = colourAt(u, v)
      const i = (cy * 128 + cx) * 4
      px[i] = rgb[0] * shade
      px[i + 1] = rgb[1] * shade
      px[i + 2] = rgb[2] * shade
      px[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  if (id == null) return
  const font = await getFont()
  const text = String(id)
  const s = 3
  const x = Math.round((128 - measure(font, text) * s) / 2)
  const y = Math.round((128 - font.ch * s) / 2)
  drawText(ctx, font, text, x + s, y + s, { scale: s, color: "#3f3f3f" })
  drawText(ctx, font, text, x, y, { scale: s, color: "#ffffff" })
}
