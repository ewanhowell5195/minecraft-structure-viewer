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
- Shift/ctrl-click structures to pack several into one scene, each on its own
  floor grid; export the scene as `.glb` or `.obj`.
- Walk mode: pointer-locked first person with Minecraft physics: collision,
  step-up, sprint, crouch with edge guard, ladders, fly, noclip, view bobbing,
  and doors that open when you click them.
- World mode: open a world save, browse its map, and build any chunk selection;
  Explore World streams the open world around you in walk mode (tiles build in
  workers as you move, docs/STREAMING.md), and exiting leaves you orbiting the
  loaded chunks with the session resumable where you left off.
- Interactions: containers open their loot modal in orbit and walk mode alike
  (chest lids pose, decorated pots wobble and show their held item or roll their
  loot table), enchanting books track you, and bells ring where you whack them.

## URL params

- `?structure=<name>` load a structure by its resource-relative path, e.g.
  `minecraft/village/plains/town_centers/plains_fountain_01`; a
  comma-separated list restores a packed combination
- `?channel=snapshot` use the snapshot jar
- `?seed=<hex>&level=<n>` restore a jigsaw/procedural session
- `?minimal` strip the chrome for embedding: no sidebar, walk button,
  structure-blocks menu, or progress bars; the splash stays up with loading
  status until the structure finishes loading, and the info chip drops its
  draw/tri counts
- `?manual` load nothing on start: no vanilla jar and no default structure, so
  the embedding page drives everything over the [embed API](#embed-api).
  `?packs=` still applies if given. Independent of `?minimal`

## Embed API

An embedding page can drive the viewer over `postMessage`: choose its assets,
load structures and worlds, and serve it files it doesn't have.

The API is always listening. [`?manual`](#url-params) is what stops the viewer
loading anything on its own first, and `?minimal` strips the chrome, so an embed
usually wants both.

There is no origin check, so anyone can embed it. Every message must be marked
`source: "structure-viewer"`; anything without that marker is ignored.

```js
const frame = document.querySelector("iframe")
frame.src = "https://structure-viewer.ewanhowell.com/?minimal&manual"

let id = 0
const pending = new Map()

addEventListener("message", e => {
  if (e.data?.source !== "structure-viewer") return
  if (e.data.event === "ready") start()
  pending.get(e.data.reply)?.(e.data)
})

function send(type, body, transfer) {
  const messageId = ++id
  const done = new Promise(resolve => pending.set(messageId, resolve))
  frame.contentWindow.postMessage({ source: "structure-viewer", type, id: messageId, ...body }, "*", transfer)
  return done
}

async function start() {
  await send("loadPacks", { base: "26.2" })
  await send("loadStructure", { path: "minecraft/igloo/top" })
}
```

Wait for the `ready` event before sending anything.

### Messages

Commands come from the page. Asset requests come from the viewer, and only when a
source is a [virtual handler](#virtual-sources).

| Direction | Shape |
|---|---|
| page to viewer, command | `{ source, type, id, ...args }` |
| viewer to page, reply | `{ source, reply, ok, error, ...result }` |
| viewer to page, event | `{ source, event, ...body }` |
| viewer to page, asset request | `{ source, request, handler, op, path }` |
| page to viewer, asset response | `{ source, response, data, names, error }` |

A command is answered only if it carries an `id`. Omit it to fire and forget.
Replies are `{ reply, ok: true, ...result }` or `{ reply, ok: false, error }`,
where `error` is a message describing what went wrong.

Bytes may be an `ArrayBuffer`, `Uint8Array`, `Blob` or `File`, in either
direction. Pass an `ArrayBuffer` in the `postMessage` transfer list to hand it
over without copying, which is worth doing for anything large.

### Commands

#### `loadPacks`

`{ base, packs }`, both optional.

`base` is the lowest priority source, and is one of:

```js
"26.2"                                 // a version id, downloaded and cached by the viewer
<bytes>                                // a jar or zip you supply
{ handler: "vanilla" }                 // a virtual source you serve
null                                   // no base
```

Omitting `base` leaves whatever is loaded alone. There is no base until you set
one, and none is needed: without one the first pack acts as the base, so a
resource pack on its own renders what it ships and nothing else.

`packs` is the whole stack, highest priority first, and replaces whatever was
there. `[]` clears back to bare base. Entries are:

```js
"https://example.com/pack.zip"         // fetched by the viewer
<bytes>                                // a zip you supply
{ name: "My Pack", data: <bytes> }     // the same, with a display name
{ handler: "my-pack", name: "My Pack" } // a virtual source you serve
```

Set a base and its packs in one call rather than two: each call rebuilds the
assets once, at the end.

#### `loadStructure`

`{ data, name }` or `{ path }`.

- `data` raw structure bytes, with `name` choosing the format by extension:
  `.nbt`, `.litematic`, `.schem` or `.mcstructure`, defaulting to `.nbt`
- `path` a resource-relative path from the loaded sources, as listed by
  `listStructures`

#### `listStructures`

`{ filter }`, an optional substring. Replies `{ names }`.

#### `loadWorld`

`{ data, name, dimension, chunks, y, force }`. Replies
`{ chunks, dimensions, bounds }`.

- `data` a world `.zip` or a single `.mca` region file, chosen by `name`'s
  extension
- `dimension` which dimension to read. Defaults to the world's own
- `chunks` the chunks to build, in **chunk** coordinates, as either two opposite
  corners of a rectangle or an explicit list:

  ```js
  chunks: [[-2, -2], [5, 5]]              // rectangle, inclusive
  chunks: [[0, 0], [0, 1], [4, -3]]       // exactly these
  ```

  Chunks the world doesn't have are skipped, and the reply's `chunks` count says
  how many were actually selected. Omit `chunks` to open the world without
  building, and use the reply's `dimensions` and `bounds` to decide what to ask
  for next. A world stays open, so later calls can pass `chunks` alone
- `y` a `[min, max]` build range, defaulting to one sampled from the selected
  chunks. Worth setting: a modern world is 384 blocks tall, and height costs more
  than area
- `force` build even if the size estimate says it may exhaust memory. Without it
  an oversized request is refused with `ok: false` and the estimate

### Virtual sources

A source given as `{ handler: "<id>" }` holds no bytes. The viewer asks the page
for each file it needs, using an id you chose, so you can serve assets you have
only piecemeal, keep them behind an API, or avoid materialising a pack at all.

Requests arrive as `{ source, request, handler, op, path }`, and you answer with
the matching `response` id:

| `op` | Answer with | Meaning |
|---|---|---|
| `read` | `{ data }` | The file's bytes, or `null` if you don't have it |
| `list` | `{ names }` | What is directly inside the directory `path`, both files and subdirectory names |

```js
addEventListener("message", async e => {
  const m = e.data
  if (m?.source !== "structure-viewer" || m.request === undefined) return
  const answer = body => frame.contentWindow.postMessage({ source: "structure-viewer", response: m.request, ...body }, "*")
  if (m.op === "read") answer({ data: await myFiles.read(m.handler, m.path) ?? null })
  else if (m.op === "list") answer({ names: await myFiles.list(m.handler, m.path) })
})
```

Paths are pack-relative, exactly as they appear inside a resource pack
(`assets/minecraft/models/block/stone.json`). Requests are concurrent and may be
answered in any order, which is what the ids are for.

Three rules:

- **Answer every request**, including with `data: null` for a file you don't
  have. Requests give up after 30 seconds and count as missing
- **`list` must include subdirectory names**, not only files
- **Every texture you serve must appear in `list`**, or it renders as the missing
  texture even though `read` would have returned it

A virtual source supplies assets: models, textures, blockstates and the like. It
is never asked for structures, which arrive through
[`loadStructure`](#loadstructure) instead.

### Events

Sent without a `reply`:

- `ready` the viewer has booted and is listening
