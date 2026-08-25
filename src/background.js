// a bare hex is accepted because a literal # in the url would start the fragment
const raw = new URLSearchParams(location.search).get("background")
const value = raw && /^[0-9a-f]{3,8}$/i.test(raw) ? "#" + raw : raw
const fetches = /\b(url|image-set|image|cross-fade|element)\s*\(/i

export const customBackground = value && !fetches.test(value) && CSS.supports("background", value) ? value : ""

// a probe's computed style resolves any colour syntax (and gradient stops) to rgb()
function luminance(background) {
  const probe = document.createElement("div")
  probe.style.background = background
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const colours = (cs.backgroundColor + " " + cs.backgroundImage).match(/rgba?\([^)]*\)/g) ?? []
  probe.remove()
  const lums = []
  for (const c of colours) {
    const [r, g, b, a = 1] = c.match(/[\d.]+/g).map(Number)
    if (a === 0) continue
    const lin = v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    lums.push((0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)) * a)
  }
  return lums.length ? lums.reduce((s, v) => s + v) / lums.length : 0
}

// 0.179 is where black text starts beating white on contrast ratio
export const lightBackground = !!customBackground && luminance(customBackground) > 0.179

if (customBackground) document.body.style.background = customBackground
