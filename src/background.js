// a bare hex is accepted because a literal # in the url would start the fragment
const raw = new URLSearchParams(location.search).get("background")
const value = raw && /^[0-9a-f]{3,8}$/i.test(raw) ? "#" + raw : raw
const fetches = /\b(url|image-set|image|cross-fade|element)\s*\(/i

if (value && !fetches.test(value) && CSS.supports("background", value)) {
  document.body.style.background = value
}
