export async function exposeViewer() {
  const [packs, structures, structure, build, scene, session, walk, stream, container, world, bake] = await Promise.all([
    import("./composables/usePacks.js"),
    import("./composables/useStructures.js"),
    import("./composables/useStructure.js"),
    import("./composables/useBuild.js"),
    import("./composables/useScene.js"),
    import("./composables/useSession.js"),
    import("./composables/useWalk.js"),
    import("./composables/useStream.js"),
    import("./composables/useContainer.js"),
    import("./composables/useWorld.js"),
    import("./bake.js")
  ])
  window.__sv = {
    packs: packs.usePacks(),
    structures: structures.useStructures(),
    structure: structure.useStructure(),
    build: build.useBuild(),
    scene: scene.useScene(),
    session: session.useSession(),
    walk: walk.useWalk(),
    stream: stream.useStream(),
    container: container.useContainer(),
    world: world.useWorld(),
    bake: bake.bake
  }
}
