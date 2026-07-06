# Progress

Update this file with every commit. It is the handoff document: a fresh session with no
other context must be able to resume from here (read docs/PLAN.md and docs/SOURCES.md
first, then this).

## State

- Phase: 0 (research). Repo initialised, plan + sources written.
- **IMPORTANT: the research is NOT done.** PLAN.md's feature checklist is from memory
  of the project, not from a completed scan. Before implementing ANY area, the full
  forensic pass is mandatory: read every remaining old module end to end, walk the
  commit history, and mine the July 5 transcript (assistant messages too, not just the
  user extract) for that area's decisions and bug fixes. DECISIONS.md must be written
  from that scan, area by area, and is the spec the new code is written from.
- Read so far from the old code: nbt.js (fully), transforms.js (fully),
  full SV commit history (both pages of `git log v2-dev -- projects/structure-viewer ...`).
- NOT yet read: app.js, optimise.js, jigsaw.js, combine.js, generators/*, walk.js,
  structure.html, style.css. Read them via `git show v2-dev:projects/structure-viewer/<f>`
  in the BlockModelRenderer repo, and mine the July 5 transcript per SOURCES.md.
- docs/DECISIONS.md not started: it must capture, per area, the behaviours + the bugs
  that were fixed (walk physics constants, jigsaw overlap rules, optimiser passes,
  door handling, centring rules, seed semantics) BEFORE that area is reimplemented.

## Next steps

1. Read the remaining old modules; write docs/DECISIONS.md area by area
   (jigsaw+transforms+combine, generators, optimiser, walk, app behaviours).
2. Mine the July 5 transcript for decisions not visible in code/commits.
3. Commit docs. Then scaffold Vite + Vue 3 app (PLAN.md build order step 1).

## Environment notes

- Ewan hosts `http://localhost:8080/` serving the BlockModelRenderer repo (library dev
  CDN stand-in). Playwright MCP is the browser-testing tool (NOT the preview MCP).
- Vite dev server: run in background, test pages with Playwright against it.
- Do not run npm render scripts in the library repo; visual verification is Ewan's.
- Commit style: lowercase, terse, subject well under 72 chars, body only when it earns
  its place, never any attribution. No emdashes in ANY prose or code, ever
  (rephrase with colon/comma/parentheses); do not strip them from quoted material.
