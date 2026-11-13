import { createRouter } from "vue-router"
import { routerHistory, VIEWER_PATH } from "./history.js"
import Home from "./home/Home.vue"

const SITE = "https://structureviewer.com"

const routes = [
  {
    path: "/",
    component: Home,
    meta: {
      title: "Structure Viewer - Every Minecraft Structure in 3D",
      description: "View every Minecraft structure and worldgen feature in 3D. Test out how they generate, load your own structures and world saves, and apply resource packs, mods, and datapacks."
    }
  },
  {
    path: VIEWER_PATH,
    component: () => import("./App.vue"),
    meta: {
      title: "Structure Viewer - View Minecraft Structures in 3D",
      description: "View every Minecraft structure and worldgen feature in 3D. Test out how they generate, load your own structures and world saves, and apply resource packs, mods, and datapacks."
    }
  },
  { path: "/app", redirect: to => ({ path: VIEWER_PATH, query: to.query, hash: to.hash }) }
]

export const router = createRouter({
  history: routerHistory,
  routes,
  scrollBehavior: (to, from, saved) => saved ?? (to.hash ? { el: to.hash } : { top: 0 })
})

function setMeta(selector, attribute, value) {
  document.head.querySelector(selector)?.setAttribute(attribute, value)
}

router.afterEach(to => {
  const { title, description } = to.meta
  const url = SITE + to.path
  document.title = title
  setMeta('meta[name="description"]', "content", description)
  setMeta('link[rel="canonical"]', "href", url)
  setMeta('meta[property="og:url"]', "content", url)
  setMeta('meta[property="og:title"]', "content", title)
  setMeta('meta[property="og:description"]', "content", description)
})
