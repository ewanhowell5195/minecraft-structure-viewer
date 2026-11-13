import { onSession } from "./session.js"

// ?manual hands control to the embedding page: no vanilla jar and no default
// structure are loaded, and nothing renders until the parent drives it over the
// embed API (src/embed.js)
export let manual = false

onSession(() => {
  const value = new URLSearchParams(location.search).get("manual")
  manual = value !== null && value !== "false"
})
