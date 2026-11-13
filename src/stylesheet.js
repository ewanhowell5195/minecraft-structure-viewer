import { onUnmounted } from "vue"

export function useStylesheet(css) {
  const style = document.createElement("style")
  style.textContent = css
  document.head.prepend(style)
  onUnmounted(() => style.remove())
}
