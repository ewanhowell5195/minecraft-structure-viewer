# Progress

Update this file with every commit. It is the handoff document: a fresh session with no
other context must be able to resume from here (read docs/PLAN.md and docs/SOURCES.md
first, then this).

## State

- Phase: 0 (research) COMPLETE. The full forensic pass is done:
  - Every old module read end to end (app.js, optimise.js, jigsaw.js, combine.js,
    walk.js, generators/{igloo,endcity,mansion,index}.js, nbt.js, transforms.js,
    structure.html, style.css, mojang-pack.js).
  - Full SV commit history walked (~70 commits, oldest-first).
  - July 5 transcript mined: all 841 user messages plus the assistant messages
    (extracted to scratchpad assistant_msgs.txt, grepped per area) for the free-region
    overlap fix, ow/carving semantics, ship-height verdict, per-level seed design and
    why "reload last level" was removed, view-bob formulas, namespace + `structures/`
    folder fixes, and the waterlogged-string library bug.
- **docs/DECISIONS.md is written and is the spec.** 18 sections: nbt, transforms,
  jigsaw solver, combine, generators, optimiser, walk, packs, discovery/tree,
  worldgen index/filters, build pipeline, doors, level sessions/seeds/URL,
  camera/grid/view, collect, export, locking, open questions. Write the new code
  from it; do not port the old files.
- Build step 1 (scaffold) DONE: Vite + Vue 3 app, sidebar + viewport layout,
  Material Symbols link, library bootstrap in src/lib.js (npm three@0.162.0 handed
  over via configure({ three }), runtime import of http://localhost:8080/src/web.js
  with @vite-ignore, overridable via VITE_LIB_URL). Verified with Playwright on the
  Vite dev server (npm run dev, port 5173): "Renderer ready", console clean.

## Environment note: the 8080 library server

The app runs on the Vite dev server (5173) so the library fetch is CROSS-ORIGIN now,
unlike the old same-origin example pages. Ewan's 8080 server must send CORS headers
(Access-Control-Allow-Origin) or the dynamic import fails with
ERR_CONNECTION_REFUSED-style fetch errors. For testing without his server there is a
tiny CORS static server in the session scratchpad (lib-server.mjs) serving the
BlockModelRenderer repo on 8080; recreate it if lost (any static server with CORS
and correct .js/.zip MIME types works).

- Build step 2 (packs) DONE: src/mojang.js (proxy download, Cache Storage per
  channel), src/composables/usePacks.js (ordered multi-pack overlay state, bytes
  kept out of reactivity, rebuildAssets with dispose-after-swap lifecycle via a
  `swap` callback that later hosts the scene rebuild), PacksSection.vue (Release/
  Snapshot channel buttons, pack rows with move up/down + remove, vanilla base row,
  Add Resource Pack or Mod with multi-select). Playwright-verified: release +
  snapshot channels (?channel= param), add two real packs (Dokucraft + dungeons-
  and-taverns from Downloads), reorder, remove; console clean throughout.

- Build step 3 (structure sources) DONE: src/nbt.js (reader per DECISIONS 1),
  src/proc.js (PROC table), src/composables/useStructures.js (discovery across the
  union of pack sources incl. legacy structures/ folders, worldgen index for
  starters/standalone/structDepth, auto-refresh on assetsVersion),
  src/composables/useStructure.js (current structure load: vanilla via readFile +
  zip path, user .nbt upload, ?vanilla= param), StructuresSection.vue +
  TreeFolder.vue (lazy folder tree, single-child chain compaction, namespace hidden
  when sole, count badge, text filter flat list capped 500, all/standalone/starters
  dropdown, Open Structure File). Playwright-verified on 26.2: 1212 structures,
  starters 178/1212 (matches the old viewer exactly), standalone 128, igloo/top
  loads (7×5×8, 152 blocks info chip), text filter shows full paths, ?vanilla=
  reload auto-loads. Console clean.

- Build step 4 (basic build) DONE: useScene.js (renderer, persp/ortho cameras with
  manual-vs-auto ortho revert, OrbitControls, fit at 30/225, block-aligned grid,
  wireframe override material, rAF loop with animator registry), useBuild.js
  (template per palette entry with legacy renames + wall prop fix, nonSolid
  detection, raw clone-per-block group, grid-snapped centring, atomic swap +
  dispose, info stats, lighting world/off rebuild), useLock.js (refcounted global
  lock), useStructure funnels loads into build and registers the pack swap handler
  (vanilla re-reads from new assets, else rebuild in place), ViewSection.vue.
  Playwright-verified: igloo/top and village plains fountain render correctly
  (textures, water, jigsaw blocks), ortho + wireframe + grid toggles work, filter
  + selection work, console clean.

- Build step 5 (optimiser) DONE: src/optimise.js implements the full DECISIONS 6
  pipeline (extractFlat with canonical corner orientation, greedy meshing on the
  phase lattice with MAX_TILE 512 chunking, shelf atlases with 1px extruded gutter
  + FNV pixel-hash dedupe + MAX_ATLAS 8192 spill, opaque/translucent split with
  no-depth-write translucency, animated materials fixed in place, coplanar overlay
  demotion, per-block getCullFaces memoised on state+neighbours). useBuild swaps
  atlas textures with the group and disposes old ones. Playwright-verified:
  plains fountain draws 724 -> 4 (water still animated/live), ancient city
  city_center_1 (7966 blocks) draws 51K -> 8 / tris 102K -> 10.8K, wireframe shows
  multi-block merged quads, culling visibly removes interior faces. Console clean.
  Doors (DECISIONS 12) are NOT in yet: openable blocks currently bake into the
  merged mesh; they come with the doors/walk work.

## Next steps

1. Build order step 6 (wireframe/collect/export): collect mode (DECISIONS 15),
   export .glb/.obj optimised + raw (DECISIONS 16). Wireframe already done.
   Doors (DECISIONS 12) fit naturally right before or with this step since export
   must skip hidden door halves.
2. Then steps 7-10 per PLAN.md.
3. Open questions to settle with Ewan when relevant (DECISIONS.md section 18):
   pack-change auto-rebuild or explicit, easy-tooltips vs in-app tooltip, samples.

## Environment notes

- Ewan hosts `http://localhost:8080/` serving the BlockModelRenderer repo (library dev
  CDN stand-in). Playwright MCP is the browser-testing tool (NOT the preview MCP).
- Vite dev server: run in background, test pages with Playwright against it.
- Do not run npm render scripts in the library repo; visual verification is Ewan's.
- Commit style: lowercase, terse, subject well under 72 chars, body only when it earns
  its place, never any attribution. No emdashes in ANY prose or code, ever
  (rephrase with colon/comma/parentheses); do not strip them from quoted material.
