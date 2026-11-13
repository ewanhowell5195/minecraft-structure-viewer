# Homepage screenshots

Screenshots of the viewer for the homepage, taken from a saved camera pose so they can be retaken when the UI changes.

## Retake

1. Run the dev server: `npx vite --port 5183 --strictPort`.
2. Run `node tools/shots/shot.js` for every shot, or `node tools/shots/shot.js world` for one.

## Change a shot

Run `node tools/shots/shot.js world --pose`. A browser opens with the world loaded at the saved pose. Move the camera, change the daytime or the chunk selection, then click Save shot. Align camera puts the camera and daytime back to the saved pose, for after a new chunk selection. The new pose is saved to `shots.json` and the shot is taken.

## Options

| Flag | |
|---|---|
| `--pose` | Line the shot up by hand before taking it. Takes one shot name. |
| `--rezip` | Rebuild the cached world zip, after the save has changed. |
| `--base=<url>` | The viewer to use. Default `http://localhost:5183`. |

## shots.json

| Key | |
|---|---|
| `save` | The world folder, by name in `%APPDATA%/.minecraft/saves` or as an absolute path. |
| `dimension` | The dimension folder zipped with `level.dat`. |
| `params` | The viewer URL query: the chunk selection and Y range. |
| `camera` | `position` and `target` of the orbit camera, in world block coordinates. |
| `daytime` | The daytime slider value. |
| `viewport` | The page size in CSS pixels. |
| `clip` | `[x, y, width, height]` of the page to keep, in CSS pixels. |
| `scale` | The device pixel ratio. |
| `width` | The output width in pixels. |
| `quality` | The WebP quality. |
| `out` | The output file, relative to the repo root. |

## Notes

- Needs Google Chrome installed.
- The world zip is cached in `tools/shots/.cache`.
