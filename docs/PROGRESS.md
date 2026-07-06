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

## Next steps

1. Build order step 3 (structure sources): nbt reader (DECISIONS 1), discovery of
   data/<ns>/structure(s)/*.nbt across all pack sources (DECISIONS 9), sidebar tree
   with compaction + namespace rules, text filter, .nbt upload. Worldgen filters
   (DECISIONS 10) can land here or with step 7; the tree + all/standalone/starters
   dropdown skeleton belongs here.
2. Then steps 4-10 per PLAN.md, each from its DECISIONS.md section, committing +
   Playwright-testing each and updating this file.
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
