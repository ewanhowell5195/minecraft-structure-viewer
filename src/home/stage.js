import { FXAA_FRAGMENT, FXAA_VERTEX } from "../fxaa.js"

const VERSION = 4
const MIP_LEVELS = 4
const VERTEX_BYTES = 16
const CHUNK_QUADS = 16384
const GRID_REACH = 6
const ANIMATION_SLOTS = 32
const TICK_MS = 50
const GROW_MS = 420
const WAVE_MS = 1100
const FALL_BLOCKS = 3
const JITTER_MS = 240
const HEIGHT_MS = 90
const LEVEL_SLOTS = 8
const QUARTER_TURNS = [[1, 0], [0, 1], [-1, 0], [0, -1]]

const VERTEX_SHADER = `#version 300 es
  in vec3 position;
  in vec2 uv;
  in vec3 color;
  in float anim;
  in vec2 build;
  uniform mat4 view;
  uniform vec2 shift;
  uniform float scale;
  uniform vec3 grid;
  uniform vec2 turn;
  uniform vec4 levels[${LEVEL_SLOTS}];
  uniform vec4 animFrames[${ANIMATION_SLOTS}];
  uniform float animMix[${ANIMATION_SLOTS}];
  out vec2 vUv;
  out vec2 vUvNext;
  out float vMix;
  out vec3 vColor;
  float bit(float value, float place) {
    return mod(floor(value / place), 2.0);
  }
  void main() {
    int slot = int(anim + 0.5);
    vec4 frames = animFrames[slot];
    vUv = uv + frames.xy;
    vUvNext = uv + frames.zw;
    vMix = animMix[slot];
    vColor = color;
    vec4 state = levels[int(mod(build.x, 8.0) + 0.5)];
    bool inside = bit(build.x, 64.0) > 0.5;
    vec3 at = position / scale;
    vec3 q = at - grid;
    vec3 sides = vec3(bit(build.x, 8.0), bit(build.x, 16.0), bit(build.x, 32.0));
    vec3 middle = floor(q + 0.5) - sides * step(abs(fract(q) - 0.5), vec3(0.001)) + grid;
    float jitter = inside ? fract(sin(dot(middle, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * ${JITTER_MS}.0 : 0.0;
    float height = inside ? floor(middle.y) : 0.0;
    float delay = max(build.y - state.y, 0.0) * state.z + height * ${HEIGHT_MS}.0 + jitter;
    float t = clamp((state.x - delay) / ${GROW_MS}.0, 0.0, 1.0);
    if (inside) {
      float s = 1.0 - pow(1.0 - min(t / 0.35, 1.0), 3.0);
      at = middle + (at - middle) * s;
    }
    at.y += ${FALL_BLOCKS}.0 * (1.0 - t * t);
    at.xz = vec2(at.x * turn.x + at.z * turn.y, at.z * turn.x - at.x * turn.y);
    gl_Position = view * vec4(at, 1.0);
    gl_Position.xy += shift * gl_Position.w;
    if (t <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }
`

const FRAGMENT_SHADER = `#version 300 es
  precision highp float;
  uniform sampler2D atlas;
  uniform float blend;
  in vec2 vUv;
  in vec2 vUvNext;
  in float vMix;
  in vec3 vColor;
  out vec4 colour;
  void main() {
    vec4 texel = mix(texture(atlas, vUv), texture(atlas, vUvNext), vMix);
    if (texel.a < mix(0.5, 0.01, blend)) discard;
    colour = vec4(texel.rgb * vColor, mix(1.0, texel.a, blend));
  }
`

const GRID_VERTEX_SHADER = `#version 300 es
  in vec2 corner;
  uniform mat4 view;
  uniform vec2 shift;
  uniform vec2 focus;
  uniform float reach;
  out vec2 vCell;
  void main() {
    vCell = focus + corner * reach;
    gl_Position = view * vec4(vCell.x, 0.0, vCell.y, 1.0);
    gl_Position.xy += shift * gl_Position.w;
  }
`

const GRID_FRAGMENT_SHADER = `#version 300 es
  precision highp float;
  uniform vec2 focus;
  uniform float reach;
  uniform vec2 even;
  in vec2 vCell;
  out vec4 colour;
  float lines(vec2 at) {
    vec2 width = fwidth(at);
    vec2 near = abs(fract(at - 0.5) - 0.5) / width;
    return (1.0 - min(min(near.x, near.y), 1.0)) * (1.0 - smoothstep(0.1, 0.35, max(width.x, width.y)));
  }
  void main() {
    vec2 at = vCell - even * 0.5;
    float fade = 1.0 - smoothstep(reach * 0.3, reach, length(vCell - focus));
    colour = vec4(0.12, 0.23, 0.48, max(lines(at) * 0.28, lines(at / 16.0) * 0.4) * fade);
  }
`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`stage: ${gl.getShaderInfoLog(shader)}`)
  return shader
}

function link(gl, vertex, fragment) {
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`stage: ${gl.getProgramInfoLog(program)}`)
  return program
}

function cameraAxes(yaw, pitch) {
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
  return [[cy, 0, -sy], [-sp * sy, cp, -sp * cy], [cp * sy, sp, cp * cy]]
}

function viewProjection(camera, aspect, radius) {
  const { yaw, pitch, distance, target, fov } = camera
  const axes = cameraAxes(yaw, pitch)
  const eye = target.map((c, a) => c + axes[2][a] * distance)
  const rows = axes.map(axis => axis.concat(-(axis[0] * eye[0] + axis[1] * eye[1] + axis[2] * eye[2])))
  const near = Math.max(distance - radius, distance / 100), far = distance + radius * GRID_REACH
  const f = 1 / Math.tan(fov / 2), depth = (far + near) / (near - far), shift = 2 * far * near / (near - far)
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    out[c * 4] = rows[0][c] * f / aspect
    out[c * 4 + 1] = rows[1][c] * f
    out[c * 4 + 2] = rows[2][c] * depth + (c === 3 ? shift : 0)
    out[c * 4 + 3] = -rows[2][c]
  }
  return out
}

function hull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = [], upper = []
  for (const point of points) {
    while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop()
    lower.push(point)
  }
  for (const point of points.slice().reverse()) {
    while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop()
    upper.push(point)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

function footprint(words, count) {
  const seen = new Set(), points = []
  let top = 0
  for (let i = 0; i < count; i++) {
    const x = words[i * VERTEX_BYTES / 2], y = words[i * VERTEX_BYTES / 2 + 1], z = words[i * VERTEX_BYTES / 2 + 2]
    top = Math.max(top, y)
    const key = x * 65536 + z
    if (seen.has(key)) continue
    seen.add(key)
    points.push([x, z])
  }
  return { points: hull(points), top }
}

function halve({ data, width, height }) {
  const half = { data: new Uint8Array(width * height), width: width / 2, height: height / 2 }
  for (let y = 0; y < half.height; y++) for (let x = 0; x < half.width; x++) {
    const texels = [0, 1, width, width + 1].map(step => ((y * 2 * width) + x * 2 + step) * 4)
    const weight = texels.reduce((sum, i) => sum + data[i + 3], 0)
    const at = (y * half.width + x) * 4
    for (let c = 0; c < 3; c++) half.data[at + c] = Math.round(weight ? texels.reduce((sum, i) => sum + data[i + c] * data[i + 3], 0) / weight : texels.reduce((sum, i) => sum + data[i + c], 0) / 4)
    half.data[at + 3] = Math.round(weight / 4)
  }
  return half
}

async function request(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`stage: ${url} returned ${response.status}`)
  return response
}

export function createStage(canvas) {
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: false })
  if (!gl) throw new Error("stage: WebGL2 is not available")

  const program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER)
  const attributes = { position: gl.getAttribLocation(program, "position"), uv: gl.getAttribLocation(program, "uv"), color: gl.getAttribLocation(program, "color"), anim: gl.getAttribLocation(program, "anim"), build: gl.getAttribLocation(program, "build") }
  const uniforms = {}
  for (const name of ["view", "shift", "scale", "grid", "turn", "blend", "levels", "animFrames", "animMix"]) uniforms[name] = gl.getUniformLocation(program, name)
  const animFrames = new Float32Array(ANIMATION_SLOTS * 4), animMix = new Float32Array(ANIMATION_SLOTS), levelStates = new Float32Array(LEVEL_SLOTS * 4)

  const grid = link(gl, GRID_VERTEX_SHADER, GRID_FRAGMENT_SHADER)
  const gridSlots = { corner: gl.getAttribLocation(grid, "corner"), view: gl.getUniformLocation(grid, "view"), shift: gl.getUniformLocation(grid, "shift"), focus: gl.getUniformLocation(grid, "focus"), reach: gl.getUniformLocation(grid, "reach"), even: gl.getUniformLocation(grid, "even") }
  const gridBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  const smoothing = link(gl, FXAA_VERTEX, FXAA_FRAGMENT)
  const smoothingSlots = { position: gl.getAttribLocation(smoothing, "position"), pixel: gl.getUniformLocation(smoothing, "pixel") }
  const screenBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, screenBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const frameTexture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, frameTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const indices = new Uint16Array(CHUNK_QUADS * 6)
  for (let q = 0; q < CHUNK_QUADS; q++) indices.set([0, 1, 2, 0, 2, 3].map(corner => q * 4 + corner), q * 6)
  const indexBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)

  const camera = { yaw: 0.6, pitch: 0.35, distance: 1, target: [0, 0, 0], fov: 35 * Math.PI / 180, shift: [0, 0] }
  const models = new Map()
  const growth = { target: LEVEL_SLOTS, clocks: new Array(LEVEL_SLOTS).fill(0), moving: false }
  let model = null, quarter = 0, frame = 0, last = 0, onScreen = false, dirty = false

  function drawGrid(view) {
    gl.useProgram(grid)
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer)
    gl.enableVertexAttribArray(gridSlots.corner)
    gl.vertexAttribPointer(gridSlots.corner, 2, gl.FLOAT, false, 0, 0)
    gl.uniformMatrix4fv(gridSlots.view, false, view)
    gl.uniform2fv(gridSlots.shift, camera.shift)
    gl.uniform2f(gridSlots.focus, camera.target[0], camera.target[2])
    gl.uniform1f(gridSlots.reach, model.radius * GRID_REACH * 0.5)
    const [width, , depth] = model.header.size
    gl.uniform2f(gridSlots.even, (quarter % 2 ? depth : width) % 2, (quarter % 2 ? width : depth) % 2)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.depthMask(false)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disableVertexAttribArray(gridSlots.corner)
  }

  function animate(time) {
    const ticks = time / TICK_MS
    model.header.animations.forEach((animation, k) => {
      const at = ticks % animation.total
      let step = 0
      while (animation.ends[step] <= at) step++
      const next = (step + 1) % animation.steps.length
      const [u, v] = animation.frames[animation.steps[step]], [nu, nv] = animation.frames[animation.steps[next]]
      animFrames.set([u, v, nu, nv], (k + 1) * 4)
      animMix[k + 1] = animation.interpolate ? (at - (animation.ends[step] - animation.times[step])) / animation.times[step] : 0
    })
    gl.uniform4fv(uniforms.animFrames, animFrames)
    gl.uniform1fv(uniforms.animMix, animMix)
  }

  function drawLayer(chunk, layer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer)
    for (let start = layer.start, end = layer.start + layer.count; start < end; start += CHUNK_QUADS) {
      const offset = start * 4 * VERTEX_BYTES
      gl.vertexAttribPointer(attributes.position, 3, gl.SHORT, false, VERTEX_BYTES, offset)
      gl.vertexAttribPointer(attributes.uv, 2, gl.UNSIGNED_SHORT, true, VERTEX_BYTES, offset + 6)
      gl.vertexAttribPointer(attributes.color, 3, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, offset + 10)
      gl.vertexAttribPointer(attributes.anim, 1, gl.UNSIGNED_BYTE, false, VERTEX_BYTES, offset + 13)
      gl.vertexAttribPointer(attributes.build, 2, gl.UNSIGNED_BYTE, false, VERTEX_BYTES, offset + 14)
      gl.drawElements(gl.TRIANGLES, Math.min(CHUNK_QUADS, end - start) * 6, gl.UNSIGNED_SHORT, 0)
    }
  }

  function drawModel(view, time) {
    gl.useProgram(program)
    gl.bindTexture(gl.TEXTURE_2D, model.texture)
    for (const slot of Object.values(attributes)) gl.enableVertexAttribArray(slot)
    gl.uniformMatrix4fv(uniforms.view, false, view)
    gl.uniform2fv(uniforms.shift, camera.shift)
    gl.uniform1f(uniforms.scale, model.header.scale)
    gl.uniform3fv(uniforms.grid, model.header.grid ?? [0, 0, 0])
    gl.uniform2fv(uniforms.turn, QUARTER_TURNS[quarter])
    levelStates.fill(0)
    if (model.levels) model.levels.forEach((level, index) => levelStates.set([growth.clocks[index], level.rings[0], WAVE_MS / Math.max(1, level.rings[1] - level.rings[0])], index * 4))
    else levelStates[0] = 1e30
    gl.uniform4fv(uniforms.levels, levelStates)
    animate(time)
    gl.enable(gl.CULL_FACE)
    const chunks = model.chunks.filter((chunk, level) => chunk.buffer && (!model.levels || growth.clocks[level] > 0))
    for (const blend of [false, true]) {
      gl.uniform1f(uniforms.blend, blend ? 1 : 0)
      gl.depthMask(!blend)
      if (blend) gl.enable(gl.BLEND)
      else gl.disable(gl.BLEND)
      for (const chunk of chunks) for (const layer of chunk.header.layers) if (layer.blend === blend) drawLayer(chunk, layer)
    }
    for (const slot of Object.values(attributes)) gl.disableVertexAttribArray(slot)
    gl.depthMask(true)
  }

  function draw() {
    dirty = false
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    if (!model) return
    const view = viewProjection(camera, canvas.width / canvas.height, model.radius)
    drawGrid(view)
    drawModel(view, performance.now())
    smooth()
  }

  function smooth() {
    gl.bindTexture(gl.TEXTURE_2D, frameTexture)
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, canvas.width, canvas.height)
    gl.useProgram(smoothing)
    gl.bindBuffer(gl.ARRAY_BUFFER, screenBuffer)
    gl.enableVertexAttribArray(smoothingSlots.position)
    gl.vertexAttribPointer(smoothingSlots.position, 2, gl.FLOAT, false, 0, 0)
    gl.uniform2f(smoothingSlots.pixel, 1 / canvas.width, 1 / canvas.height)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.disable(gl.CULL_FACE)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.disableVertexAttribArray(smoothingSlots.position)
    gl.enable(gl.DEPTH_TEST)
  }

  function resize() {
    const width = Math.round(canvas.clientWidth * devicePixelRatio), height = Math.round(canvas.clientHeight * devicePixelRatio)
    if (!width || !height || (canvas.width === width && canvas.height === height)) return
    canvas.width = width
    canvas.height = height
    gl.viewport(0, 0, width, height)
    gl.bindTexture(gl.TEXTURE_2D, frameTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    draw()
  }

  function tick(time) {
    frame = requestAnimationFrame(tick)
    const delta = last ? time - last : 0
    stage.onFrame?.(time, delta)
    last = time
    if (growth.moving) advance(Math.min(delta, 100))
    if (dirty || model?.header.animations.length) draw()
  }

  function advance(delta) {
    growth.moving = false
    model.chunks.forEach((chunk, level) => {
      if (!chunk.buffer) {
        if (level <= growth.target) growth.moving = true
        return
      }
      const goal = level <= growth.target ? chunk.span : 0, clock = growth.clocks[level]
      if (clock === goal) return
      growth.clocks[level] = growth.instant ? goal : clock < goal ? Math.min(goal, clock + delta) : Math.max(goal, clock - delta)
      growth.moving = dirty = true
    })
  }

  function sync() {
    const running = onScreen && !document.hidden
    if (running && !frame) frame = requestAnimationFrame(tick)
    if (!running && frame) {
      cancelAnimationFrame(frame)
      frame = last = 0
    }
  }

  function setCamera(next) {
    Object.assign(camera, next)
    dirty = true
  }

  function fetchChunk(chunk) {
    chunk.ready ??= request(`/home/baked/${chunk.header.bin}`).then(r => r.arrayBuffer()).then(vertices => {
      chunk.buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer)
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
      chunk.footprint = footprint(new Int16Array(vertices), chunk.header.quads * 4)
      chunk.span = WAVE_MS + JITTER_MS + GROW_MS + Math.max(0, Math.ceil(chunk.footprint.top / chunk.scale) - 1) * HEIGHT_MS
      dirty = true
    })
    return chunk.ready
  }

  async function fetchModel(name) {
    const header = await request(`/home/baked/${name}.json`).then(r => r.json())
    if (header.version !== VERSION) throw new Error(`stage: ${name} is baked format version ${header.version}, this loader reads version ${VERSION}`)
    if (header.animations.length >= ANIMATION_SLOTS) throw new Error(`stage: ${name} has ${header.animations.length} animated textures, this loader has room for ${ANIMATION_SLOTS - 1}`)
    for (const animation of header.animations) {
      let end = 0
      animation.ends = animation.times.map(t => end += t)
      animation.total = end
    }
    const chunks = header.chunks.map(chunk => ({ header: chunk, scale: header.scale, buffer: null, ready: null }))
    const [blob] = await Promise.all([request(`/home/baked/${header.atlas}`).then(r => r.blob()), fetchChunk(chunks[0])])
    const atlas = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })
    if (atlas.width % (1 << MIP_LEVELS) || atlas.height % (1 << MIP_LEVELS)) throw new Error(`stage: ${name}'s atlas is ${atlas.width}x${atlas.height}, mipmaps need both sides to be multiples of ${1 << MIP_LEVELS}`)
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas)
    let level = { data: new Uint8Array(atlas.width * atlas.height * 4), width: atlas.width, height: atlas.height }
    const reader = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, reader)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.readPixels(0, 0, level.width, level.height, gl.RGBA, gl.UNSIGNED_BYTE, level.data)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(reader)
    for (let k = 1; k <= MIP_LEVELS; k++) {
      level = halve(level)
      gl.texImage2D(gl.TEXTURE_2D, k, gl.RGBA, level.width, level.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, level.data)
    }
    for (const side of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, side, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, MIP_LEVELS)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    chunks.slice(1).reduce((before, chunk) => before.then(() => fetchChunk(chunk)), Promise.resolve())
    const radius = Math.hypot(header.size[0], header.size[1], header.size[2])
    return { header, chunks, texture, radius, levels: header.levels ?? null, fit: radius / 2 / Math.sin(camera.fov / 2) }
  }

  function grow(level, instant = false) {
    if (!model?.levels) throw new Error("stage: grow needs a model baked with levels")
    for (const chunk of model.chunks.slice(0, level + 1)) fetchChunk(chunk)
    Object.assign(growth, { target: level, instant, moving: true })
  }

  function remaining() {
    return Math.max(0, ...model.chunks.map((chunk, level) => level <= growth.target ? WAVE_MS + JITTER_MS - growth.clocks[level] : growth.clocks[level]))
  }

  function fit({ yaw, pitch, height, level, nearest = 0 }, margin = 0.94) {
    const shown = model.chunks.slice(0, level + 1).filter(chunk => chunk.footprint)
    const points = hull(shown.flatMap(chunk => chunk.footprint.points))
    if (!points.length) points.push([0, 0])
    const top = Math.max(0, ...shown.map(chunk => chunk.footprint.top))
    const middle = axis => (Math.min(...points.map(point => point[axis])) + Math.max(...points.map(point => point[axis]))) / 2 / model.header.scale
    const target = [middle(0), height, middle(1)]
    const axes = cameraAxes(yaw, pitch)
    const across = Math.tan(camera.fov / 2) * (canvas.width / canvas.height || 1), upward = Math.tan(camera.fov / 2)
    const corners = points.flatMap(([x, z]) => [0, top].map(y => {
      const q = [x / model.header.scale - target[0], y / model.header.scale - target[1], z / model.header.scale - target[2]]
      return axes.map(axis => axis[0] * q[0] + axis[1] * q[1] + axis[2] * q[2])
    }))
    function spread(distance) {
      const xs = corners.map(([side, , back]) => side / (distance - back) / across), ys = corners.map(([, up, back]) => up / (distance - back) / upward)
      return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    }
    function fits(distance) {
      const [x0, x1, y0, y1] = spread(distance)
      return x1 - x0 <= 2 * margin && y1 - y0 <= 2 * margin
    }
    let near = Math.max(...corners.map(corner => corner[2])) + 0.5, far = near + 1
    while (!fits(far)) far = near + (far - near) * 2
    for (let i = 0; i < 24; i++) {
      const mid = (near + far) / 2
      if (fits(mid)) far = mid
      else near = mid
    }
    far = Math.max(far, nearest)
    const [x0, x1, y0, y1] = spread(far)
    return { distance: far, target, shift: [-(x0 + x1) / 2, -(y0 + y1) / 2] }
  }

  function load(name) {
    if (!models.has(name)) models.set(name, fetchModel(name))
    return models.get(name)
  }

  async function show(name, quarters = 0) {
    model = await load(name)
    quarter = (quarters % 4 + 4) % 4
    growth.clocks.fill(0)
    Object.assign(growth, { target: LEVEL_SLOTS, instant: false, moving: Boolean(model.levels) })
    dirty = true
    return model
  }

  function dispose() {
    onScreen = false
    sync()
    visible.disconnect()
    sized.disconnect()
    document.removeEventListener("visibilitychange", sync)
    gl.getExtension("WEBGL_lose_context")?.loseContext()
  }

  const stage = { camera, onFrame: null, load, show, grow, remaining, fit, setCamera, resize, dispose }
  const visible = new IntersectionObserver(entries => {
    onScreen = entries[entries.length - 1].isIntersecting
    sync()
  })
  const sized = new ResizeObserver(resize)
  visible.observe(canvas)
  sized.observe(canvas)
  document.addEventListener("visibilitychange", sync)
  resize()
  return stage
}
