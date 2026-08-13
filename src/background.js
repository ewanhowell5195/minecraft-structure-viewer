// ?background=<css colour> paints behind the transparent canvas. a bare hex is
// accepted because a literal # in the url would start the fragment, and the
// value has to pass as a colour so the param can't smuggle in other css
const raw = new URLSearchParams(location.search).get("background")
const value = raw && /^[0-9a-f]{3,8}$/i.test(raw) ? "#" + raw : raw

export const background = value && CSS.supports("color", value) ? value : ""
