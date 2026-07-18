// ?minimal strips the chrome for embedding: no sidebar, walk button,
// structure-blocks menu, chips, or progress bars; the splash stays up with
// loading status until the first build lands
export const minimal = new URLSearchParams(location.search).has("minimal")
