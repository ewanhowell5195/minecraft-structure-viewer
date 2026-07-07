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

- Build step 6 (doors/collect/export) DONE (wireframe landed with step 4):
  - Doors (DECISIONS 12) in useBuild.js: openable blocks (door/trapdoor/fence_gate
    with an `open` prop) are excluded from the optimised mesh; both open+closed
    palette entries/templates are ensured and cloned onto the root with visibility
    matching state. toggleDoor repoints b.state (collision follows), door halves
    pair via the cell above/below and toggle together. rayDoor marches the look
    ray (2-unit steps, reach 80, dedupe cells, solid non-air stops it); interact/
    aimDoor/blockAt/currentBoxes exported for walk mode later. main.js exposes a
    DEV-only window.__sv handle for browser testing.
  - Collect (DECISIONS 15): state.collect checkbox; a new load commits the current
    group/animator/atlas textures/collision boxes into a `placed` list (ownership
    transfer, so the build swap doesn't dispose them), lays out left-to-right
    (sceneRight + 32 + sx*8, grid-snapped). Rebuilds in place (lighting, pack swap)
    keep their spot via a `replace` flag on build(); pack-swap re-reads pass it so
    they no longer count as new loads (also no longer refit the camera). Clear
    Collected disposes everything placed and rebuilds current at origin; loading
    with collect off clears placed first.
  - Export (DECISIONS 16): src/export.js, Save as… dropdown (.glb/.obj, optimised
    or raw). Meshes re-materialised to MeshStandardMaterial (map, transparent,
    alphaTest 0.5 cutout, roughness 1, metalness 0, side kept), textures redrawn
    onto real canvases (OffscreenCanvas atlases aren't portable), baked to world
    space, hidden subtrees skipped via traverseVisible (non-showing door half stays
    out); meshes carrying invisible material groups are exploded per visible group.
    Raw re-expands the current structure per block from templates (doors follow
    b.state); collected structures always export optimised. GLTFExporter binary /
    OBJExporter, leaf-name filename (+ -raw), object URL revoked after 2s.
  - Playwright-verified on plains_small_house_1 + igloo/top + plains_fountain_01:
    door toggle open/close with paired halves, ray blocked by walls, three
    structures collected side by side with live water, clear returns to origin,
    glb magic + obj text + raw/collected mesh counts all correct. Console clean.

- Build step 7 (jigsaw + levels) DONE:
  - src/transforms.js (DECISIONS 2): DIR/HORIZ/OPP, rotPos/rotDir, mulberry32
    rnd + shuffle + mix, parseState, rotateState (facing/axis/rotation/connection
    sides), mirrorPos/mirrorState (mansion-ready), air regexes, jigsawsOf,
    worldJigsaw, pieceBox/boxHit/inBox, poolTemplates with EMPTY symbol.
  - src/combine.js (DECISIONS 4): later-piece-wins cells, ow carving, mansion
    chest markers, jigsaw final_state, normalise + palette dedupe + anchor.
  - src/jigsaw.js (DECISIONS 3): BFS per-level rng (levelSeed(d+1)), pool +
    fallback candidates, canAttach (front/joint/target), attach-inside free
    regions (src.onPlot) vs global boxes, maxRadius 96, caps 128 pieces.
  - src/composables/useSession.js (DECISIONS 13): session for jigsaw palettes
    (procedurals hook in via the exported `generators` map, filled in step 8),
    0-based level, seed picked on first ascent + cleared at base, ops
    next/all/undo/reset/reloadAll/fullReload (all/full target Infinity and clamp
    after re-probe), anchor-delta camera tracking on regenerate, ?seed=<hex> +
    ?level=<1-based> URL sync and one-time adoption, rebase() for pack swaps.
  - LevelMenu.vue bottom-right expandable menu; disabled states at ends; whole
    menu pointer-events off while locked. main.js __sv gains session.
  - Playwright-verified: plains fountain grows 117 -> 298 -> 883 -> 4052 blocks
    (draws 30.7K -> 5), undo/redo reproducible (fingerprint match), URL reload
    with seed+level rebuilds the identical village, reload re-rolls at depth,
    reset returns to base + clears URL, outpost assembles on its base plate
    (no tent pile-up), non-jigsaw structures get no menu. Console clean.

- Build step 8 (procedural generators) DONE: src/generators/{igloo,endcity,
  mansion,index}.js per DECISIONS 5, adapted from the old validated ports
  (rng -> rnd rename only, seed-consumption order untouched). useSession's
  generators map wires igloo/end_city/mansion to the PROC entries; probeDepth
  runs a steppable generator at Infinity when a seed is picked so "next"
  disables at the seed's true depth; the one-shot mansion (steps false) skips
  probing and shows Generate/Regenerate; menu head hides "level N" for it.
  Playwright-verified: igloo steps top(114) -> shaft(219) -> basement(398) and
  undo/redo is stable; end city prefix-stable across undo/redo, per-seed depth
  (7 and 15 seen), 6K-block multi-tower city renders with bridges; mansion
  generates 37K-43K blocks in ~2.5s at 4 draws with 61 marker chests, re-rolls
  differ, URL seed adoption rebuilds the identical mansion. Console clean.

- Build step 9 (walk mode) DONE: src/composables/useWalk.js per DECISIONS 7
  (transcribed from the old validated walk.js, adapted to composables), plus
  WalkOverlay.vue (canvas-centre difference-blend crosshair, hint bar) and a
  Walk Around button in ViewSection. useScene exposes perspCam/FOV/
  updateProjection/canvas and a setWalkUpdate frame hook (walk drives the
  camera instead of controls.update()). All MC constants preserved: sizes/
  speeds/gravity/jump, STEP 9 with eased step-up, double-tap sprint + fly,
  noclip with bump-out, sneak edge guard, ladder rules, embedded-box exemption,
  pointer-lock exit handling, door interact + outline + collision rebuild.
  requestPointerLock rejection swallowed (automation/no-gesture contexts).
  Playwright-verified numerically: gravity settles the eye at ground+25.92,
  walk 78/s, sprint 118/s, fly 140/s rise, crouch eye 20.32, jump arc up ~19
  and back, closed door blocks at its panel face and opens to walk through,
  exit restores FOV 45 + OrbitControls with a valid target. Console clean.

## Next steps

1. Build order step 10 (polish + final docs) per PLAN.md.
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
