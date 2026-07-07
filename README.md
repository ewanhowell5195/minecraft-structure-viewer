# minecraft structure viewer

Browse, assemble and walk around Minecraft structures in the browser. Ground-up
rewrite of the structure viewer that lived in the block-model-renderer repo, as
a standalone Vue 3 + Vite app.

## Features

- Structure tree from the vanilla client jar (release or snapshot, downloaded
  and cached per channel) plus any number of resource packs / data packs / mod
  jars layered on top in an ordered overlay list.
- Filters: all / standalone / starters (from a scan of the worldgen template
  pools), text filter, and loading `.nbt`, `.litematic`, `.schem` and
  `.mcstructure` files from disk (Bedrock blockstates translated best-effort).
- Renderer: greedy meshing + texture atlases + face culling collapse most
  structures to a handful of draw calls; water/lava/fire stay animated; doors,
  trapdoors and gates stay live and toggleable.
- Jigsaw assembly: grow a structure through its template pools level by level,
  exactly like worldgen (weighted pools, fallbacks, joints, per-source overlap
  rules). Seeded and reproducible; seed + level persist in the URL.
- Procedural generators: igloo, end city and woodland mansion are assembled in
  code from the decompiled game logic, with the same level stepping.
- Collect mode keeps structures side by side; export the scene as `.glb` or
  `.obj`.
- Walk mode: pointer-locked first person with Minecraft physics: collision,
  step-up, sprint, crouch with edge guard, ladders, fly, noclip, view bobbing,
  and doors that open when you click them.

## Dev

```
npm install
npm run dev
```

The app loads the `block-model-renderer` library at runtime from
`http://localhost:8080/src/web.js` (a static server on the library repo stands
in for the CDN; it must send CORS headers). Override the URL with
`VITE_LIB_URL`. The app owns `three` and hands it to the library via
`configure({ three })`, so there is only ever one three instance.

## URL params

- `?vanilla=<name>` load a vanilla structure, e.g.
  `minecraft/village/plains/town_centers/plains_fountain_01`
- `?channel=snapshot` use the snapshot jar
- `?seed=<hex>&level=<n>` restore a jigsaw/procedural session
