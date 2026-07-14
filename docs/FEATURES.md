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

## 6. Viewer wiring

- `useFeatures.populate` indexes `packs.featureSources()` (user packs +
  bundled zips, never the vanilla jar) and reads the viewer jsons;
  `state.names` excludes delisted names but `featurePath`/`has()` keep
  them resolvable.
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

## 7. New-version runbook

1. `node tools/features/extract.js <version>`; act on "structure dupe ..."
   notes; Java compile errors mean mappings moved in FeatureExtract.java.
2. `node tools/features/verify.js <version>`; port new types / fix codec
   drift until exit 0. Diff the new dump against the old zip to spot
   renamed fields.
3. Generator changes that alter output (block counts or randomness
   consumption) shift the default seeds and the hidden list: re-run
   extract.js after them. It is cheap (256 samples per feature).
4. Removed features: no action, all outputs regenerate.
5. Ewan checks visuals in the browser (a tree, a disk, a delisted selector
   URL); do not build screenshot harnesses.
