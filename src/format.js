export const mb = n => (n / 1048576).toFixed(0)
export const num = n => n.toLocaleString("en")
export const kilo = n => n >= 1000 ? +(n / 1000).toFixed(1) + "K" : String(Math.round(n))
