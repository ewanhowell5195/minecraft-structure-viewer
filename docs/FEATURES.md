# Features tab: pipeline spec and version-update runbook

Written 2026-07-14 from the session that built it. This is the reference for
regenerating or extending the system on a new game version; the constants,
resolution rules, and gotchas below were all hard-won, do not regress them.

## 1. Data flow

```
FeatureExtract.java  walks Registries.FEATURE, encodes each entry with
                     Feature.DIRECT_CODEC through RegistryOps(JsonOps), one
                     JSON per feature -> <cache>/features-out/
extract.js           compiles+runs it, deletes STRUCTURE_DUPES and every
                     unreferenced delist candidate (single-block features,
                     ref-only selectors), computes the viewer indexes,
                     writes the loose tree to bundled/features/ and packs
                     public/features.zip
verify.js            regression gate: every feature at seeds 0 and 3, no
                     error, no empty output, exit 0
```

The zips pack from tracked loose trees (bundled/features/, and
bundled/builtin/ for the structures zip), the same pattern as
BlockModelRenderer's assets/ + assets.zip: git diffs show the real content
changes, the committed zip is a derived artifact. The zip writer embeds no
timestamps and sorts entries, so identical content gives identical bytes.
`node tools/build-bundles.js` repacks both zips after a hand edit under
bundled/; the extractors do it automatically.

features.zip contents:
- `data/<ns>/worldgen/feature/<path>.json` (the dump)
- `viewer/hidden_features.json` + `viewer/redundant_selectors.json`
  (delisted-but-kept names, section 5; written only when non-empty, and
  today every selector was removable so only the hidden file ships)
- `viewer/default_seeds.json` + `viewer/static_features.json` (section 4)
- `viewer/feature_folders.json` (flat rel -> folder map for the tree,
  from the hand-curated tools/features/folders.json; section 6)
- `viewer/feature_biomes.json` (per-tree home-biome grass tint for the
  grass pad, in the lib's `biome` parse-arg shape: `{ temperature,
  downfall }` samples the colormap; `{ tint }` for fixed-color biomes
  (pale garden, cherry grove, dappled forest) and swamp (whose modifier
  ignores the colormap and noise-picks #4C763C or #6A7039 in game; the
  pad uses the dominant #6a7039); climate + `tint: "#28340a"` +
  `combine: true` for dark forest, whose modifier folds a constant onto
  the sampled color: `(base & 0xFEFEFE) + tint >> 1`. The biome is the
  most common tint among the biomes that reach the feature, oceans/
  rivers/beaches filtered; unplaced base trees (dark_oak, plain birch,
  the poplars) borrow their variants' biomes by name prefix)
- `viewer/structure_dupes.json` (tools-side record, the viewer ignores it)

The zip is the lowest-priority pack source (`usePacks`: featureBytes next to
builtinBytes). The features LIST never indexes the vanilla jar
(`featureSources` in usePacks): minecraft features exist only if bundled, so
anything the tools removed stays gone even on snapshot jars that ship
worldgen JSONs as data. Datapacks and mods are separate sources: they
override/extend by name, and anything not in the bundled indexes renders
live with free re-roll. The flip side: a brand-new vanilla feature in a
snapshot won't appear until extract.js re-runs (it would need a generator
port anyway).

Commands (JDK required, shared cache `tools/builtin/.cache/<version>/`):
```
node tools/features/extract.js [version]   # several minutes, enumeration is the slow part
node tools/features/verify.js  [version]   # must print "failing groups: 0" and exit 0
```
version defaults to the latest snapshot on Mojang's manifest.

## 2. Reference resolution (lib.js, mirrored in useFeatures.js)

- Feature ids collide across the PLACED and FEATURE registries
  (`birch_bees_0002` is both). A placed feature's inner `feature` ref points
  at the FEATURE registry; resolving it back through placed loops forever.
- `resolvePlaced(ref)`: object with `.feature` -> follow into FEATURE
  registry; string -> try placed registry (client.jar
  `data/*/worldgen/placed_feature/`) then fall through to FEATURE.
- Structure templates (fossil/template types) come from the client jar's
  `data/*/structure/*.nbt` via the `loadStruct` argument; in the viewer,
  `loadFeature` builds that closure from `structures.zipPathOf`.

## 3. Generator ports (src/features/)

`generateFeature(name, json, rand, resolvePlaced, loadStruct)`; world is a
`Map "x,y,z" -> {Name, Properties}`, assembled via `statePicker()` with
anchor `[-minX, 0, -minZ]`.

Rules that keep breaking if forgotten:
- The grid is the ground: never synthesize terrain pads. Terrain-dependent
  features get a minimal empty-world adaptation (springs: rock pocket;
  multiface/vines: small host wall), commented at the handler.
- RNG is mulberry32 (`rnd` in transforms.js): distribution-faithful, never
  bit-exact with Java. Port algorithm structure and distributions exactly.
- Java int division truncates toward zero, `Math.floor` does not: use
  `Math.trunc` on possibly-negative operands. Real bug once: blob foliage
  `- yo / 2` with floor made oak/birch one leaf layer too wide at odd
  negative rows (vanilla oak radii bottom-up are 2,2,1,1).
- Dumps omit codec-default fields (geode needed distribution_points,
  point_offset, wall, placements_require_layer0_alternate filled by hand).
- String-or-array codec fields dump as whichever form was registered
  (nether springs' `valid_blocks` is a bare string): normalise with
  `[x].flat()`.
- Inline `{feature, placement}` entries in `sequence`/`overlay` go through
  `applyPlacement`: `offset`, `rarity_filter` (consumes a nextInt), and
  `environment_scan` (steps `direction_of_search`, tests `target_condition`
  via `testPredicate`, gives up after `max_steps` or when
  `allowed_search_condition` fails; scan failure drops the entry). All
  other modifiers (counts, biome/height filters) are meaningless for a
  single showcase placement and are ignored. sulfur_pool is the reference
  case: lake, then potent_sulfur scanned down into the floor.
- `testPredicate` supports not/all_of/any_of/solid/matching_blocks/
  matching_fluids (waterlogged counts as water)/matching_block_tag(air
  only). `simple_block` replaces its target like vanilla (no is-empty
  check); the double-plant branch adds the upper half only into air.
- JS negative zero: `Math.ceil(-0.3)` is `-0`, and `10 / -0` is
  `-Infinity` where Java's int `0` divides to `+Infinity`. Any ported
  `(int)` cast whose result can be zero and later divides or sign-gates
  needs `| 0` (icebergs grew a floating half-plane slab from this).
- A clamped IntProvider's `minInclusive()`/`maxInclusive()` return the
  CLAMP fields, not the intersection with the source; providers.js
  `intBounds` matches that.
- When a feature renders wrong, don't tweak the approximation: decompile
  the class (the whole feature package sits decompiled in
  `tools/builtin/.cache/<version>/ddec/out`) and port `place()` exactly.
  The 2026-07 audit replaced ~20 approximations this way.
- New feature type: decompile with Vineflower against the unobfuscated jar
  in the cache, port `place()` into `TYPES`, re-run verify (unsupported
  types fail there with "feature type X isn't supported yet").

## 4. Default seeds (extract.js, sampleRolls)

One entry per feature; a load without an explicit seed uses a
representative roll, not seed 0 (which often lands a tiny output).
`DEFAULT_SAMPLES=256`: generate seeds 0..255, sort by block count, take the
seed in the middle of the range. `HANDPICKED_SEEDS` (extract.js) overrides
the median for named features (a good-looking roll beats a statistically
average one); the extractor logs a note when a handpicked name stops
existing. `viewer/default_seeds.json` is a flat `{ "<ns>/<path>": seed }`
map; entries equal to 0 are omitted and the viewer falls back to 0 (also
the fallback for datapack features). The same sampling pass hashes every
roll: features whose shape never changed land in
`viewer/static_features.json`, and the viewer gives those no Re-roll and
no Field (no floating menu at all, like a static structure). It also
flags the features whose rolls never exceed a single block, which feed
the hidden/removed handling in section 5.

A variant-enumeration system (per-shape entries, tree skeleton classes with
rotation folding) existed briefly and was replaced by this on request; if
it is ever wanted again, the session transcript of 2026-07-14 has the full
spec and a working implementation.

## 5. Delists and drops

Removal is safe because the viewer never lists minecraft features from the
jar (section 1): a file deleted from the zip is gone on every channel, no
client-side name list needed. Names ship to the client only for files that
must STAY in the zip as resolution targets while staying out of the tree.

- `STRUCTURE_DUPES` (extract.js): features duplicating extracted builtin
  structures (bonus_chest, desert_well, monster_room, end_gateway_*,
  end_platform, end_spike, end_podium_*). Deleted from the zip;
  `viewer/structure_dupes.json` is only the tools' record of what was
  dropped. The extractor logs "no longer exists in this version, prune it"
  when a name disappears; that log line is the whole removal-maintenance
  story, since everything else regenerates from the registry each run.
- Template stampers join the same drop automatically (`stampsTemplates`): a
  feature with a `template` node anywhere in its config only ever shows
  structure nbts the structures tab already lists (sulfur_spring), so it
  is excluded from the site entirely, not hidden. `fossil` features stay:
  their overlays rot the bones and embed coal / deepslate diamond ore
  (there are no diamond nbts, a processor swaps the coal overlay), which
  is generation the structures can't show.
- Delist candidates, found per extraction:
  - ref-only selectors: selector types (random_selector,
    weighted_random_selector, simple_random_selector,
    random_boolean_selector) whose entries ALL bottom out in registry ids
    (`isRef`). They only pick between features the list already shows
    (birch_tall, trees_*). Selectors with inline configs (seagrass sizes,
    sulfur_spring) are content and stay listed.
  - single-block features: EVERY sampled roll is one block, or a
    lower+upper double plant (sunflower); a lone flower is not content.
    Detected in the same 256-seed pass as the defaults, so a feature that
    is usually one block but can roll more stays listed.
- `removableFeatures` then splits the candidates by the reference scan
  (any string anywhere in any config that names a feature, directly or via
  the placed registry, over-detecting on purpose; keep-set floods from the
  non-candidates, so candidate chains that only reference each other drop
  whole). Unreferenced candidates are deleted from the zip. Referenced
  ones (brown_mushroom, moss_vegetation, the vegetation-patch fillers)
  stay in the zip so resolution keeps working, and their names ship in
  `viewer/hidden_features.json` / `viewer/redundant_selectors.json` for
  the tree filter. Singles never get default-seed or static entries.

## 6. Feature folders (folders.json)

The tree's folders are hand-curated in tools/features/folders.json
(`{ "<folder/path>": ["name", ...] }`, names without the namespace);
extract.js flattens it to `viewer/feature_folders.json` and logs notes for
stale entries, duplicates, and unfiled listed features. Categorising is a
judgement call, not code: it weighs what a feature IS, what it does, and
where it generates in game.

To file new features, run the aid:
```
node tools/features/info.js [version]
```
It prints every listed feature with its current folder (or UNFILED), config
type, generation steps, and the biomes that reach it (traversing placed
refs and selector chains in the jar, so a tree buried behind three
selectors still shows its real biomes). Type suggests the what (tree, ore,
disk, spring_feature); steps and biomes suggest the where
(underground_decoration + nether biomes -> ores/nether, lush_caves ->
caves/lush).

Conventions the current layout follows, keep them:
- trees/ splits by SPECIES (the logs decide, not the leaves), with
  trees/fallen for the fallen logs; azalea includes rooted_azalea_tree.
- Variant forms (bonemeal, planted, leaf_litter, bees) sit NEXT TO their
  base feature, never in variant folders.
- Dimension folders (nether/, end/) collect what only generates there;
  nether ores still live in ores/nether so all ores browse together.
- caves/ groups by cave biome/theme: lush, dripstone, sculk, sulfur, with
  cross-biome cave features (amethyst_geode, glow_lichen) at its root.
- Thematic folders beat type folders when they read better: fluids
  (springs + lava lake), ice, disks, piles, fossils, mushrooms; misc only
  for genuine one-offs (forest_rock).
- Datapack features are never filed: anything without a mapping lists at
  the root, which is correct for them.

## 7. Viewer wiring

- `useFeatures.populate` indexes `packs.featureSources()` (user packs +
  bundled zips, never the vanilla jar) and reads the viewer jsons;
  `state.names` excludes delisted names but `featurePath`/`has()` keep
  them resolvable.
- Feature loads pass `{ grass: grassBiome(rel) }` as generateFeature's
  `pad` arg: tree/fallen_tree features get a display-only grass_block
  layer one below origin, and icebergs get ocean water from their keel up
  to sea level (the origin line), filling the air inside the feature
  bounds plus a 3-block apron outside them. It consumes NO rand, so
  seeds/statics are
  unaffected and the extractor and og-image (which never pad) stay in
  sync. The declared size stays the tree's own bounds (apron blocks sit
  at out-of-range positions, which the viewer's map-keyed pipeline
  handles), so tiles, grids, and packing behave exactly like any other
  structure and the standard +3 tile border is what the apron fills. The
  grass palette entry carries `__biome` (the feature_biomes.json value),
  which useBuild passes as the per-block `biome` in its `createScene`
  call; mergeParts keys palette entries on it so combined loads keep
  per-tree tints.
- `generateTree`/`generateFallenTree` accept
  `opts.runFeature(id, x, y, z)` (tree-local coords): the tree handler
  queues those calls and awaits them after generation. The pale_moss
  decorator uses it for pale_moss_patch at the lowest log, passing the
  origin WITHOUT vanilla's `.above()`, because the adapted
  vegetation_patch grounds rigidly at origin-1 instead of scanning down.
- The list renders as a folder tree from `folderOf(rel)` (curated paths,
  section 6); the rel stays the id for URLs, selection, and datapack
  overrides, and unmapped (datapack) features list at the root. Both tabs
  share TreeFolder, parameterised by a provided `treeApi` (selection
  source, file click/menu, folder Load all); filtering switches to the
  same flat list the structures tab uses.
- The Features list is the same list system as the structures tree, not a
  parallel one: an "All Features" root row (context menu: Load all, honours
  the filter), and clicks go through the shared `clickLoad(catalog, rel,
  ev)` in useStructure.js. A catalog supplies the visual order and how a
  rel becomes a loaded entry; `structCatalog` reads nbts, `featureCatalog`
  generates at the default seed. Plain click loads one, ctrl-click toggles
  membership, shift-click loads the range from the anchor; entries from
  both tabs can combine into one packed build (`apply()` splits the
  selections back per tab).
- URLs: single feature `?feature=<rel>` (+`&fseed=<hex seed>` only when it
  differs from the default; hex like the session's ?seed, parsed by
  `parseSeedParam`); several features `?feature=a,b,c` (defaults, no
  seeds); all-structure combos keep the encoded `?vanilla=!...` form;
  mixed combos get no url.
- Re-roll: one feature -> fresh rand32 seed in ?fseed; several features ->
  every one re-rolls (seeds not persisted); hidden for mixed combos since
  re-rolling would drop the structures.
- Field (button next to Re-roll, or right-click a feature row): up to
  FIELD_N=256 rolls of one feature in a single build on a uniform grid
  (packField: every cell is the largest footprint, rolls centre in their
  cells, no per-cell labels). Seeds derive deterministically from the base
  (index 0 IS the base roll, the rest are `mix(base, i)`), duplicates
  dedupe by shape, cells sort small to large. Url `?feature=<rel>&field=1`
  (+fseed when the base isn't the default), so fields reload and share
  deterministically. While a field is up the button reads "Re-roll Field"
  (re-bases the whole field), "Single" returns to the base roll, and any
  list click leaves field mode (a field never combines with other
  entries).
- Both list sorts use `numeric` (Intl.Collator numeric) from transforms.js.

## 8. New-version runbook

1. `node tools/features/extract.js <version>`; act on "structure dupe ..."
   notes; Java compile errors mean mappings moved in FeatureExtract.java.
2. `node tools/features/verify.js <version>`; port new types / fix codec
   drift until exit 0. Diff the new dump against the old zip to spot
   renamed fields.
3. Generator changes that alter output (block counts or randomness
   consumption) shift the default seeds and the hidden list: re-run
   extract.js after them. It is cheap (256 samples per feature).
4. Removed features: no action, all outputs regenerate.
   New features: file each in folders.json per section 6 (info.js shows
   type/steps/biomes; extract.js logs "has no folder" until done); prune
   entries it reports as stale.
5. Ewan checks visuals in the browser (a tree, a disk, a delisted selector
   URL); do not build screenshot harnesses.
6. The grass pad's climate tints need a lib shipping the `biome` parse
   arg (added after 2.3.0). Until that release, src/lib.js points at
   localhost:8080 (marked TEMP); revert it to the jsdelivr URL after
   publishing.
