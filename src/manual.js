// ?manual hands control to the embedding page: no vanilla jar and no default
// structure are loaded, and nothing renders until the parent drives it over the
// embed API (src/embed.js)
const value = new URLSearchParams(location.search).get("manual")

export const manual = value !== null && value !== "false"
