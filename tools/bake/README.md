# Baked models

Static meshes for the homepage, drawn by `src/home/stage.js`.

## Bake a model

1. Run the dev server: `npx vite --port 5183 --strictPort`.
2. Open the structure in the viewer, eg `http://localhost:5183/app/?structure=minecraft/pillager_outpost/watchtower` or `http://localhost:5183/app/?feature=minecraft/cherry`.
3. Wait for the label at the top of the viewport to show the block count.
4. Run `await __sv.bake("outpost")` in the browser console.
5. Move the three downloaded files into `public/home/baked/`.
6. Check it at `http://localhost:5183/tools/bake/test.html?model=outpost`.

## Current models

| Name | Source |
|---|---|
| `camp` | `?structure=minecraft/abandoned_camp/tent/bamboo_jungle/tent_bamboo_jungle_2&seed=24&level=3` |
| `outpost` | `?structure=minecraft/pillager_outpost/watchtower` |
| `portal` | `?structure=minecraft/ruined_portal/giant_portal_1` |
| `shipwreck` | `?structure=minecraft/shipwreck/with_mast` |
| `ancient_city` | `?structure=minecraft/ancient_city/city_center/city_center_2` |
| `cherry` | `?feature=minecraft/cherry` |
| `jungle` | `?feature=minecraft/mega_jungle_tree` |
| `village` | `?structure=minecraft/village/plains/town_centers/plains_fountain_01&seed=491&level=7` |

The village is baked with `{ around: [4.5, 0, 4.5], cull: false, levels }`.
`levels` is the block keys at viewer levels 1 to 7. Level 1 is the start piece alone, loaded without `seed` or `level` in the URL; `&seed=491&level=N` loads level N from 2 up.
A block key is `"x,y,z"` relative to the start piece anchor (`__sv.build.current.value.anchor`), for every non-air block in `__sv.build.current.value`.
Wait for each level to finish building before reading its blocks: the label changes as the levels are added.

## Notes

- `__sv.bake` only exists in the dev build.
- The name takes `a-z`, `0-9`, `_` and `-`.
- `await __sv.bake("outpost", { download: false })` returns `{ header, textures, files }` without downloading.
- `around: [x, y, z]` centres the model on that point of the start piece instead of on the footprint.
- `cull: false` keeps every face of every block except fluids, lit as if the blocks were all in place.
- `levels: [[key, ...], ...]` tags each block with the first level it appears in, for `stage.grow`, and writes one vertex file per level.
- The bake uses the structure as loaded, at the default daytime of 1000.
- Entities other than cushions, item frames, shelf items, sign text and technical block icons are not baked.
- End portal and end gateway blocks throw.
- Model loader materials with their own opacity, blending or skinning throw.

## Format, version 4

- `<name>.json`: `{ version, size, scale, atlas, atlasSize, quads, chunks, animations, grid, levels }`.
- `size` is the bounding box of the non-air blocks, in blocks.
- `chunks` is one entry per vertex file: `{ bin, quads, layers }`. A model baked with levels has one chunk per level, `<name>.<level>.bin`; any other model has one, `<name>.bin`.
- `layers` are quad ranges within the chunk `{ start, count, blend }`: the cut-out layer first, then the blended layer when there is one.
- `grid`, only with levels, is the fractional part of every block centre on each axis.
- `levels`, only with levels, is `{ blocks, rings }` per level: the blocks shown at that level, and the lowest and highest ring among its new blocks.
- `animations` is one entry per animated texture: `{ frames, steps, times, interpolate }`.
- `frames` are `[u, v]` offsets from the first frame's place in the atlas, in atlas units.
- `steps` index into `frames`, and `times` give each step's length in game ticks of 50 ms.
- `interpolate` blends each step into the next over its length.
- Each chunk's bin: `quads * 4` vertices of 16 bytes, little endian.
- Bytes 0 to 5: int16 `x, y, z`, in blocks times `scale`.
- `x` and `z` are relative to the centre of the footprint, `y` to the bottom of the lowest block.
- Bytes 6 to 9: uint16 `u, v`, 0 to 65535 across the atlas, `v = 0` at the top row of the image, pointing at the first frame.
- Bytes 10 to 12: uint8 `r, g, b`, the tint times the baked light.
- Byte 13: uint8 animation, 0 for none, otherwise 1 plus the index into `animations`.
- Byte 14, only with levels: bits 0 to 2 are the block's level; bits 3 to 5 are set on x, y and z when the vertex sits exactly on the block's upper face on that axis; bit 6 is set when every vertex of the quad lies within its block, so it can scale around the block centre.
- Byte 15, only with levels: the block's horizontal distance from the model centre, in half blocks.
- The block centre is `round(p - grid) + grid` on each axis, one lower where bits 3 to 5 mark a tie.
- Each quad is wound counter-clockwise seen from outside and drawn as triangles `0-1-2` and `0-2-3`.
- Blended quads are in paint order.
- `<name>.png`: the atlas, both sides a multiple of 16. Each tile, and each frame of an animated tile, starts on a 16 texel grid and fills its cell with its extruded edge pixels, so mip levels 1 to 4 stay within the tile.
