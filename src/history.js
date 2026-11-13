import { createWebHistory } from "vue-router"

export const routerHistory = createWebHistory()
export const VIEWER_PATH = "/app/"

export function pathOf(url) {
  const at = new URL(url, location.href)
  return at.pathname + at.search + at.hash
}
