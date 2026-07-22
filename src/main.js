import { createApp } from "vue"
import App from "./App.vue"
import "./styles.css"

createApp(App).mount("#app")

if (import.meta.env.DEV) {
  Promise.all([
    import("./composables/usePacks.js"),
    import("./composables/useStructures.js"),
    import("./composables/useStructure.js"),
    import("./composables/useBuild.js"),
    import("./composables/useScene.js"),
    import("./composables/useSession.js"),
    import("./composables/useWalk.js"),
    import("./composables/useStream.js"),
    import("./composables/useContainer.js")
  ]).then(([packs, structures, structure, build, scene, session, walk, stream, container]) => {
    window.__sv = {
      packs: packs.usePacks(),
      structures: structures.useStructures(),
      structure: structure.useStructure(),
      build: build.useBuild(),
      scene: scene.useScene(),
      session: session.useSession(),
      walk: walk.useWalk(),
      stream: stream.useStream(),
      container: container.useContainer()
    }
  })
}
