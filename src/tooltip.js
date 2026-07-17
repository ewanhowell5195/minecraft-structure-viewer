import { loadLibrary } from "./lib.js"
import { usePacks } from "./composables/usePacks.js"
import { getFont, measure, drawText } from "./mcfont.js"
import { prettyName } from "./loot.js"

const strip = s => (s ?? "").replace(/^minecraft:/, "")

const RARITY = { common: "#FFFFFF", uncommon: "#FFFF55", rare: "#55FFFF", epic: "#FF55FF" }
const GRAY = "#AAAAAA"
const LORE = "#AA00AA"

const SINGLE_LEVEL = new Set(["mending", "silk_touch", "aqua_affinity", "flame", "infinity", "multishot", "channeling", "binding_curse", "vanishing_curse"])
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]

// vanilla draws the sprites over the padded text box plus a 9px margin ring
export const MARGIN = 9

let spritesPromise = null, spritesVersion = -1

function loadSprites() {
  const packs = usePacks()
  const v = packs.state.assetsVersion
  if (spritesPromise && v === spritesVersion) return spritesPromise
  spritesVersion = v
  return spritesPromise = (async () => {
    const lib = await loadLibrary()
    const assets = packs.assets.value
    const load = async name => {
      const base = `assets/minecraft/textures/gui/sprites/tooltip/${name}.png`
      const buf = await lib.readFile(base, assets)
      if (!buf) return null
      let scaling = null
      const metaBuf = await lib.readFile(base + ".mcmeta", assets)
      if (metaBuf) {
        try { scaling = JSON.parse(new TextDecoder().decode(metaBuf)).gui?.scaling ?? null } catch {}
      }
      return { img: await createImageBitmap(new Blob([buf], { type: "image/png" })), scaling }
    }
    return { background: await load("background"), frame: await load("frame") }
  })()
}

function tileInto(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh, S) {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return
  for (let y = 0; y < dh; y += sh * S) {
    const th = Math.min(sh * S, dh - y)
    for (let x = 0; x < dw; x += sw * S) {
      const tw = Math.min(sw * S, dw - x)
      ctx.drawImage(img, sx, sy, tw / S, th / S, dx + x, dy + y, tw, th)
    }
  }
}

function drawSprite(ctx, sprite, x, y, w, h, S) {
  const { img, scaling } = sprite
  const type = strip(scaling?.type ?? "stretch")
  if (type === "tile") {
    tileInto(ctx, img, 0, 0, scaling.width ?? img.width, scaling.height ?? img.height, x, y, w, h, S)
    return
  }
  if (type !== "nine_slice") {
    ctx.drawImage(img, x, y, w, h)
    return
  }
  const nw = scaling.width ?? img.width, nh = scaling.height ?? img.height
  const b = scaling.border ?? 0
  const bl = Math.min((typeof b === "object" ? b.left : b) ?? 0, w / S / 2 | 0)
  const br = Math.min((typeof b === "object" ? b.right : b) ?? 0, w / S / 2 | 0)
  const bt = Math.min((typeof b === "object" ? b.top : b) ?? 0, h / S / 2 | 0)
  const bb = Math.min((typeof b === "object" ? b.bottom : b) ?? 0, h / S / 2 | 0)
  const iw = w - (bl + br) * S, ih = h - (bt + bb) * S
  const inner = (sx, sy, sw, sh, dx, dy, dw, dh) => {
    if (scaling.stretch_inner) {
      if (sw > 0 && sh > 0 && dw > 0 && dh > 0) ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
    } else tileInto(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh, S)
  }
  ctx.drawImage(img, 0, 0, bl, bt, x, y, bl * S, bt * S)
  ctx.drawImage(img, nw - br, 0, br, bt, x + w - br * S, y, br * S, bt * S)
  ctx.drawImage(img, 0, nh - bb, bl, bb, x, y + h - bb * S, bl * S, bb * S)
  ctx.drawImage(img, nw - br, nh - bb, br, bb, x + w - br * S, y + h - bb * S, br * S, bb * S)
  inner(bl, 0, nw - bl - br, bt, x + bl * S, y, iw, bt * S)
  inner(bl, nh - bb, nw - bl - br, bb, x + bl * S, y + h - bb * S, iw, bb * S)
  inner(0, bt, bl, nh - bt - bb, x, y + bt * S, bl * S, ih)
  inner(nw - br, bt, br, nh - bt - bb, x + w - br * S, y + bt * S, br * S, ih)
  inner(bl, bt, nw - bl - br, nh - bt - bb, x + bl * S, y + bt * S, iw, ih)
}

function plain(t) {
  if (t == null) return ""
  if (typeof t === "string") {
    if (/^\s*["[{]/.test(t)) {
      try { return plain(JSON.parse(t)) } catch { return t }
    }
    return t
  }
  if (Array.isArray(t)) return t.map(plain).join("")
  return (t.text ?? "") + (t.extra ?? []).map(plain).join("")
}

function potionLabel(id, pot) {
  const item = strip(id), p = strip(pot)
  const base = item === "splash_potion" ? "Splash Potion"
    : item === "lingering_potion" ? "Lingering Potion"
    : item === "tipped_arrow" ? "Arrow" : "Potion"
  if (p === "water") return item === "tipped_arrow" ? "Arrow of Splashing" : base.replace("Potion", "Water Bottle")
  if (p === "mundane" || p === "thick" || p === "awkward") return `${prettyName(p)} ${base}`
  const eff = p.replace(/^(long_|strong_)/, "")
  return `${base} of ${prettyName(eff)}${p.startsWith("strong_") ? " II" : ""}`
}

function enchantLines(levels, out) {
  for (const [id, lvl] of Object.entries(levels ?? {})) {
    const name = prettyName(id)
    const suffix = lvl === 1 && SINGLE_LEVEL.has(strip(id)) ? "" : " " + (ROMAN[lvl - 1] ?? lvl)
    out.push({ text: name + suffix, color: GRAY })
  }
}

export function tooltipLines(stack) {
  const comp = stack.components ?? {}
  const lines = []
  const ench = comp["minecraft:enchantments"], stored = comp["minecraft:stored_enchantments"]
  const enchanted = stack.enchanted || Object.keys(ench?.levels ?? ench ?? {}).length > 0

  let rarity = strip(comp["minecraft:rarity"] ?? "common")
  if (enchanted) rarity = rarity === "rare" || rarity === "epic" ? "epic" : "rare"

  const custom = comp["minecraft:custom_name"]
  const book = comp["minecraft:written_book_content"]
  const pot = comp["minecraft:potion_contents"]?.potion
  let name = prettyName(stack.id)
  if (pot) name = potionLabel(stack.id, pot)
  if (book) name = plain(book.title?.raw ?? book.title) || name
  if (custom) name = plain(custom) || name
  lines.push({ text: name, color: RARITY[rarity] ?? RARITY.common, italic: !!custom })

  if (book) {
    if (book.author) lines.push({ text: "by " + plain(book.author), color: GRAY })
    lines.push({ text: ["Original", "Copy of original", "Copy of a copy", "Tattered"][book.generation ?? 0] ?? "Tattered", color: GRAY })
  }
  enchantLines(ench?.levels ?? ench, lines)
  enchantLines(stored?.levels ?? stored, lines)
  for (const l of comp["minecraft:lore"] ?? []) lines.push({ text: plain(l), color: LORE, italic: true })
  return lines
}

const shadowOf = color => "#" + [1, 3, 5].map(i => (parseInt(color.slice(i, i + 2), 16) >> 2).toString(16).padStart(2, "0")).join("")

function drawLine(ctx, font, line, x, y, S) {
  ctx.save()
  if (line.italic) {
    const cy = y + 4 * S
    ctx.transform(1, 0, -0.25, 1, 0.25 * cy, 0)
  }
  drawText(ctx, font, line.text, x + S, y + S, { scale: S, color: shadowOf(line.color) })
  drawText(ctx, font, line.text, x, y, { scale: S, color: line.color })
  ctx.restore()
}

export async function drawTooltip(canvas, stack, S) {
  const [sprites, font] = await Promise.all([loadSprites(), getFont()])
  const lines = tooltipLines(stack)
  if (!lines.length) return false
  const w = Math.max(...lines.map(l => measure(font, l.text)))
  const h = 8 + (lines.length - 1) * 10 + (lines.length > 1 ? 2 : 0)
  canvas.width = (w + 6 + MARGIN * 2) * S
  canvas.height = (h + 6 + MARGIN * 2) * S
  const ctx = canvas.getContext("2d")
  ctx.imageSmoothingEnabled = false
  for (const sprite of [sprites.background, sprites.frame]) {
    if (sprite) drawSprite(ctx, sprite, 0, 0, canvas.width, canvas.height, S)
  }
  let y = (3 + MARGIN) * S
  for (let i = 0; i < lines.length; i++) {
    drawLine(ctx, font, lines[i], (3 + MARGIN) * S, y, S)
    y += (i === 0 ? 12 : 10) * S
  }
  return true
}
