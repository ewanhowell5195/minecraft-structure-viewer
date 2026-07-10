import { reactive, readonly } from "vue"
import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { useContainer } from "./useContainer.js"
import { useLock } from "./useLock.js"

// First-person walk-around: a pointer-locked FPS camera with gravity, AABB
// collision against every rendered block (stairs/slabs walkable) + the ground
// plane, auto step-up, sneak edge-guard, double-tap fly, and view bobbing.
// The sim runs at Minecraft's 20 ticks/s with the camera interpolated between
// ticks, and the movement numbers (acceleration, drag, jump, fly impulses,
// FOV easing) are the vanilla ones. World units: 16 = one block.
const sceneApi = useScene()
const buildApi = useBuild()
const containerApi = useContainer()
const { locked } = useLock()

const CLIMB = /(ladder|scaffolding)$|(^|:)vine$/  // climbable (their models are flat planes, so no collision)
const PW = 4.8                                    // half-width (0.3 blocks)
// box height + eye, standing vs crouching (1.8/1.62 vs 1.5/1.27 blocks)
const H_STAND = 28.8, H_SNEAK = 24, EYE_STAND = 25.92, EYE_SNEAK = 20.32
const STEP = 9                                    // auto-climb up to ~half a block (slabs, stair fronts)
const WALK_FOV = 78
const DOUBLE_TAP = 350                            // minecraft's 7-tick window for double-tap sprint/fly

// vanilla movement constants, per tick (velocities are units/tick)
const TICK = 1 / 20
const GRAVITY = 0.08 * 16
const JUMP = 0.42 * 16                            // BASE_JUMP_POWER
const SPRINT_JUMP_BOOST = 0.2 * 16
const GROUND_DRAG = 0.6 * 0.91                    // default block friction x air drag
const AIR_DRAG = 0.91
const VERT_DRAG = 0.98
const FLY_VERT_DRAG = 0.6                         // Player.travel keeps y = oldY * 0.6 while flying
const WALK_SPEED = 0.1                            // MOVEMENT_SPEED attribute (blocks/tick of accel)
const SPRINT_MOD = 1.3
const AIR_ACCEL = 0.02, AIR_ACCEL_SPRINT = 0.025999999
const SNEAK_MOD = 0.3                             // SNEAKING_SPEED attribute
const INPUT_FRICTION = 0.98
const FLY_SPEED_DEFAULT = 0.05                    // Abilities.flyingSpeed; scroll adjusts 0..0.2

const state = reactive({ on: false, suspended: false })

const walk = {
  pos: new THREE.Vector3(), prev: new THREE.Vector3(),
  vel: new THREE.Vector3(),                       // units per tick
  yaw: 0, pitch: 0, onGround: false, crouched: false,
  h: H_STAND, eye: EYE_STAND, eyeO: EYE_STAND
}
// fly.on survives noclip: toggling noclip never touches it, so leaving noclip
// puts you back in whichever mode you came from, momentum and speed intact
const fly = { on: false, speed: FLY_SPEED_DEFAULT, lastSpace: -1e9 }
let noclip = false
let sprintW = false, lastW = -1e9                 // double-tap W latches sprint until W is released
let jumpDelay = 0                                 // vanilla noJumpDelay: held space re-jumps every 10 ticks
const bob = { dist: 0, distO: 0, val: 0, valO: 0 }// minecraft view-bob: walkDist + smoothed speed, per tick
const fovMod = { cur: 1, old: 1 }                 // vanilla fov modifier, eased 0.5/tick toward its target
let stepSmooth = 0                                // camera lag after an auto step-up, eased out like MC
let acc = 0                                       // tick accumulator
const keys = new Set()
let collHash = new Map(), floorY = 0

// outline round the interactable currently in reach (block highlight)
let outline = null
function ensureOutline() {
  outline ??= sceneApi.makeHighlight()
}

function buildCollision() {
  collHash = new Map()
  // currentBoxes() already spans collected structures and omits flat-plane
  // models (plants, vines, ladders), so you stand centred in a ladder and
  // pass through decorations
  const fc = v => Math.floor(v / 16)
  for (const b of buildApi.currentBoxes())
    for (let ci = fc(b.nx); ci <= fc(b.px); ci++)
      for (let cj = fc(b.ny); cj <= fc(b.py); cj++)
        for (let ck = fc(b.nz); ck <= fc(b.pz); ck++) {
          const k = ci + "," + cj + "," + ck
          let a = collHash.get(k)
          if (!a) collHash.set(k, a = [])
          a.push(b)
        }
  floorY = sceneApi.sceneBounds().min.y
}

const paabb = () => ({ nx: walk.pos.x - PW, px: walk.pos.x + PW, ny: walk.pos.y, py: walk.pos.y + walk.h, nz: walk.pos.z - PW, pz: walk.pos.z + PW })
const overlaps = (a, b) => !(a.px <= b.nx || a.nx >= b.px || a.py <= b.ny || a.ny >= b.py || a.pz <= b.nz || a.nz >= b.pz)

// candidate boxes overlapping an AABB, from the spatial hash (deduped)
function nearby(a) {
  const set = new Set(), fc = v => Math.floor(v / 16)
  for (let ci = fc(a.nx); ci <= fc(a.px); ci++)
    for (let cj = fc(a.ny); cj <= fc(a.py); cj++)
      for (let ck = fc(a.nz); ck <= fc(a.pz); ck++) {
        const arr = collHash.get(ci + "," + cj + "," + ck)
        if (arr) for (const b of arr) set.add(b)
      }
  return set
}

// is there headroom to stand at full height here? (else stay crouched)
function canStand() {
  const b = { nx: walk.pos.x - PW, px: walk.pos.x + PW, ny: walk.pos.y, py: walk.pos.y + H_STAND, nz: walk.pos.z - PW, pz: walk.pos.z + PW }
  for (const o of nearby(b)) if (overlaps(b, o)) return false
  return true
}
function isStuck() {
  const a = paabb()
  for (const b of nearby(a)) if (overlaps(a, b)) return true
  return false
}
// lift out of any block we're buried in, up to the first spot with room for a
// FULL 2 blocks of clearance, not just the 1.8-tall player box
function roomToStand() {
  const b = { nx: walk.pos.x - PW, px: walk.pos.x + PW, ny: walk.pos.y, py: walk.pos.y + 32, nz: walk.pos.z - PW, pz: walk.pos.z + PW }
  for (const o of nearby(b)) if (overlaps(b, o)) return false
  return true
}
const bumpUp = () => { for (let i = 0; i < 4000 && !roomToStand(); i++) walk.pos.y += 2 }

// drop straight onto the highest standing surface at or below the feet
// (the ground plane when nothing else is there)
function snapToGround() {
  const a = paabb()
  let top = floorY
  for (const b of nearby({ ...a, ny: floorY - 1 })) {
    if (b.px <= a.nx || b.nx >= a.px || b.pz <= a.nz || b.nz >= a.pz) continue
    if (b.py <= walk.pos.y + 0.01 && b.py > top) top = b.py
  }
  walk.pos.y = top
  walk.onGround = true
}

// move one axis by d, then snap out of the deepest overlapping box / the floor
function collideAxisOnce(ax, d) {
  // boxes we're already inside (e.g. a door just closed on us) are ignored so
  // we can walk out of them instead of being flung to their far side
  const pre = paabb(), embedded = new Set()
  for (const b of nearby(pre)) if (overlaps(pre, b)) embedded.add(b)
  walk.pos[ax] += d
  const a = paabb()
  let hit = false, corr = null
  if (ax === "y" && d < 0 && a.ny < floorY) { corr = floorY - a.ny; hit = true }
  for (const b of nearby(a)) {
    if (embedded.has(b) || !overlaps(a, b)) continue
    let s
    if (ax === "x") s = d > 0 ? b.nx - a.px : b.px - a.nx
    else if (ax === "y") s = d > 0 ? b.ny - a.py : b.py - a.ny
    else s = d > 0 ? b.nz - a.pz : b.pz - a.nz
    corr = corr === null ? s : (d > 0 ? Math.min(corr, s) : Math.max(corr, s))
    hit = true
  }
  // back off a hair from the surface: an exactly-flush snap can land a
  // float ulp INSIDE the box, which then counts as embedded and lets every
  // later move pass through it (walking into floors, falling out the world)
  if (corr !== null) walk.pos[ax] += corr - Math.sign(d) * 0.001
  return hit
}

// fast flying can cover several blocks a tick: split the move so a thin wall
// can't be teleported straight through
function collideAxis(ax, d) {
  if (!d) return false
  const n = Math.ceil(Math.abs(d) / 8)
  for (let i = 0; i < n; i++) if (collideAxisOnce(ax, d / n)) return true
  return false
}

// horizontal move with auto step-up: if blocked, try lifting by STEP and going
// again, then settle onto the ledge (so slabs/stairs don't need a jump).
// returns true when the move ended against a wall (so the velocity zeroes,
// like vanilla's horizontalCollision)
function stepMove(ax, d, grounded) {
  if (!d) return false
  const y0 = walk.pos.y, p0 = walk.pos[ax]
  if (!collideAxis(ax, d)) return false
  // only auto-climb while standing on something (not mid-air / mid-jump)
  if (!grounded || walk.vel.y > 0) return true
  const snapped = walk.pos[ax]
  walk.pos[ax] = p0
  // the trial lift clips against every ceiling over the current AND target
  // footprint (like vanilla's expandTowards collide): a low doorway with a
  // small rise is stepped with whatever headroom exists, where lifting the
  // full STEP buried the head in the lintel and failed the whole step
  const probe = paabb()
  if (ax === "x") { if (d > 0) probe.px += d; else probe.nx += d }
  else { if (d > 0) probe.pz += d; else probe.nz += d }
  let lift = STEP
  for (const b of nearby({ ...probe, py: probe.py + STEP })) {
    if (b.px <= probe.nx || b.nx >= probe.px || b.pz <= probe.nz || b.nz >= probe.pz) continue
    if (b.ny >= probe.py - 0.001) lift = Math.min(lift, b.ny - probe.py - 0.001)
  }
  walk.pos.y = y0 + Math.max(lift, 0)
  // stepped up ok: settle onto the ledge and stay grounded (so a staircase
  // keeps climbing frame after frame); otherwise too tall, stay put
  if (walk.pos.y > y0 + 0.01 && !collideAxis(ax, d) && !isStuck()) {
    if (collideAxis("y", y0 - walk.pos.y)) walk.onGround = true
    walk.vel.y = 0
    // the partial-tick lerp must not replay the step (stepSmooth already
    // eases the eye up from the old height): both at once dips the camera
    // half a block for a frame on every stair
    const raise = walk.pos.y - y0
    walk.prev.y += raise
    stepSmooth = Math.min(STEP, stepSmooth + raise)
    return false
  }
  walk.pos.y = y0
  walk.pos[ax] = snapped
  return true
}

// is there a block (or the ground plane) within a step below the feet? probing
// a whole step down (not just flush) lets sneak walk down slabs/stairs while
// still backing you off a real (full-block) drop, like minecraft
function supported() {
  if (walk.pos.y <= floorY + 1) return true
  const a = paabb(), probe = { nx: a.nx, px: a.px, ny: walk.pos.y - STEP, py: walk.pos.y, nz: a.nz, pz: a.pz }
  for (const b of nearby(probe)) if (overlaps(probe, b)) return true
  return false
}

// on a ladder/vine if the block at the player's centre column is climbable.
// the low sample sits just above the feet so you keep climbing until your feet
// clear the top block: the leftover upward speed then carries you onto the
// ledge instead of dropping back down
function onClimbable() {
  for (const y of [walk.pos.y + 1, walk.pos.y + walk.h * 0.5]) {
    const b = buildApi.blockAt(walk.pos.x, y, walk.pos.z)
    if (b && CLIMB.test(b.Name || "")) return true
  }
  return false
}

// sneak: a horizontal move that would leave the player unsupported (off an
// edge) is undone, so crouching keeps you on the block like minecraft
function moveGround(ax, d, grounded, edgeGuard) {
  if (!d) return false
  const px = walk.pos.x, py = walk.pos.y, pz = walk.pos.z
  const blocked = stepMove(ax, d, grounded)
  if (edgeGuard && !supported()) {
    walk.pos.set(px, py, pz)
    return true
  }
  return blocked
}

// vanilla input pipeline: normalise, x0.98, x0.3 sneaking, then scale back up
// toward the unit square so diagonals aren't slower per axis
function modifyInput(right, forward, slow) {
  const l0 = Math.hypot(right, forward)
  if (!l0) return [0, 0]
  const dx = right / l0, dz = forward / l0
  let len = INPUT_FRICTION
  if (slow) len *= SNEAK_MOD
  len = Math.min(len / Math.max(Math.abs(dx), Math.abs(dz)), 1)
  return [dx * len, dz * len]
}

function stopFlying() {
  fly.on = false
  fly.speed = FLY_SPEED_DEFAULT // vanilla resets the scroll speed with flight
}

// one 1/20s step of the vanilla movement sim
function tickSim() {
  walk.prev.copy(walk.pos)
  walk.eyeO = walk.eye
  bob.distO = bob.dist
  bob.valO = bob.val
  fovMod.old = fovMod.cur

  const sneakKey = keys.has("ShiftLeft") || keys.has("ShiftRight")
  const fwdKey = keys.has("KeyW")
  const sprintKey = keys.has("ControlLeft") || keys.has("ControlRight") || keys.has("KeyQ") || sprintW
  const flying = fly.on || noclip

  // crouch shrinks the hitbox (1.8 -> 1.5); if a low ceiling blocks standing
  // back up, stay crouched until there's headroom. the eye eases between the
  // two heights at minecraft's 0.5/tick
  walk.crouched = !flying && (sneakKey || (walk.crouched && !canStand()))
  walk.h = walk.crouched ? H_SNEAK : H_STAND
  walk.eye += ((walk.crouched ? EYE_SNEAK : EYE_STAND) - walk.eye) * 0.5

  // like vanilla, sprint needs forward input, and never while sneaking
  const sprint = sprintKey && fwdKey && !walk.crouched

  const fwd = new THREE.Vector3(-Math.sin(walk.yaw), 0, -Math.cos(walk.yaw))
  const rgt = new THREE.Vector3(Math.cos(walk.yaw), 0, -Math.sin(walk.yaw))
  const [ir, ifw] = modifyInput(
    (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
    (fwdKey ? 1 : 0) - (keys.has("KeyS") ? 1 : 0),
    walk.crouched
  )
  const inX = rgt.x * ir + fwd.x * ifw
  const inZ = rgt.z * ir + fwd.z * ifw

  if (flying) {
    // creative/spectator flight: space/shift add a 3x-speed vertical impulse,
    // horizontal accelerates by the (scrollable) fly speed, doubled while
    // sprinting; drag is 0.91 sideways and a hard 0.6 vertically
    const iy = (keys.has("Space") ? 1 : 0) - (sneakKey ? 1 : 0)
    if (iy) walk.vel.y += iy * fly.speed * 3 * 16
    const origY = walk.vel.y
    const a = fly.speed * (sprint ? 2 : 1) * 16
    walk.vel.x += inX * a
    walk.vel.z += inZ * a
    walk.onGround = false
    if (noclip) {
      walk.pos.add(walk.vel)
    } else {
      if (collideAxis("x", walk.vel.x)) walk.vel.x = 0
      if (collideAxis("z", walk.vel.z)) walk.vel.z = 0
      if (collideAxis("y", walk.vel.y) && walk.vel.y < 0) walk.onGround = true
    }
    walk.vel.x *= AIR_DRAG
    walk.vel.z *= AIR_DRAG
    walk.vel.y = origY * FLY_VERT_DRAG
    // vanilla: descending into the ground lands you and turns flight off
    if (fly.on && !noclip && walk.onGround) stopFlying()
  } else {
    const grounded = walk.onGround // pre-move contact drives accel, drag and step-up, like vanilla
    const climbing = onClimbable() && !(keys.has("Space") && grounded)
    // jump: 0.42 up, +0.2 forward while sprinting; held space re-jumps on
    // vanilla's 10-tick delay
    if (jumpDelay > 0) jumpDelay--
    if (!keys.has("Space")) jumpDelay = 0
    else if (grounded && !climbing && jumpDelay === 0) {
      walk.vel.y = Math.max(JUMP, walk.vel.y)
      if (sprint) {
        walk.vel.x += fwd.x * SPRINT_JUMP_BOOST
        walk.vel.z += fwd.z * SPRINT_JUMP_BOOST
      }
      jumpDelay = 10
    }
    // acceleration: full control on the ground (and, for playability, on a
    // ladder), vanilla's small 0.02 nudge mid-air
    const a = 16 * (grounded || climbing
      ? WALK_SPEED * (sprint ? SPRINT_MOD : 1)
      : sprint ? AIR_ACCEL_SPRINT : AIR_ACCEL)
    walk.vel.x += inX * a
    walk.vel.z += inZ * a
    // on a ladder/vine: no gravity, W climbs up, S down, sneak holds, else slide
    if (climbing) walk.vel.y = walk.crouched ? 0 : fwdKey ? 2.4 : keys.has("KeyS") ? -2.4 : -0.9
    walk.onGround = false
    // sneak keeps you on the surface even mid-step: guard while within a step
    // of ground (not only when strictly grounded), so you can't slip off an
    // edge during the little fall between stair steps
    const edgeGuard = sneakKey && walk.vel.y <= 0 && (grounded || supported())
    if (moveGround("x", walk.vel.x, grounded, edgeGuard)) walk.vel.x = 0
    if (moveGround("z", walk.vel.z, grounded, edgeGuard)) walk.vel.z = 0
    if (collideAxis("y", walk.vel.y)) {
      if (walk.vel.y < 0) walk.onGround = true
      walk.vel.y = 0
    }
    // post-move friction and gravity, vanilla travelInAir order (a ladder
    // gets ground drag to pair with its ground accel, so no sideways build-up)
    const drag = grounded || climbing ? GROUND_DRAG : AIR_DRAG
    walk.vel.x *= drag
    walk.vel.z *= drag
    if (!climbing) walk.vel.y = (walk.vel.y - GRAVITY) * VERT_DRAG
  }

  // fov modifier: x1.1 while flying, x(ratio+1)/2 from the sprint speed
  // attribute, eased 0.5/tick and clamped like vanilla's Camera.tickFov
  let target = 1
  if (flying) target *= 1.1
  target *= ((sprint ? SPRINT_MOD : 1) + 1) / 2
  fovMod.cur = Math.min(Math.max(fovMod.cur + (target - fovMod.cur) * 0.5, 0.1), 1.5)

  // view bobbing: walkDist advances by horizontal distance x 0.6 (in blocks),
  // bob eases toward the horizontal speed (capped 0.1) at 0.4/tick
  bob.dist += Math.hypot(walk.pos.x - walk.prev.x, walk.pos.z - walk.prev.z) / 16 * 0.6
  const bobTarget = (!flying && walk.onGround) ? Math.min(0.1, Math.hypot(walk.vel.x, walk.vel.z) / 16) : 0
  bob.val += (bobTarget - bob.val) * 0.4
}

const _look = new THREE.Vector3()
const lerp = (a, b, t) => a + (b - a) * t

function updateWalk(dt) {
  acc += Math.min(dt, 0.25)
  let n = 0
  while (acc >= TICK && n++ < 10) {
    acc -= TICK
    tickSim()
  }
  if (acc >= TICK) acc = 0 // heavy lag: drop the leftover instead of spiralling
  const pt = acc / TICK
  const perspCam = sceneApi.perspCam
  // render between the last two ticks, like minecraft's partial ticks
  const cx = lerp(walk.prev.x, walk.pos.x, pt)
  const cy = lerp(walk.prev.y, walk.pos.y, pt)
  const cz = lerp(walk.prev.z, walk.pos.z, pt)
  const eye = lerp(walk.eyeO, walk.eye, pt)
  const wp = lerp(bob.distO, bob.dist, pt) * Math.PI
  const B = lerp(bob.valO, bob.val, pt)
  const RAD = Math.PI / 180
  const swayU = Math.sin(wp) * B * 0.5 * 16, bounceU = Math.abs(Math.cos(wp) * B) * 16
  // ease the eye up after a step-up instead of snapping (like MC's per-tick lerp)
  stepSmooth *= Math.pow(0.5, dt / 0.045)
  if (stepSmooth < 0.05) stepSmooth = 0
  perspCam.position.set(
    cx + Math.cos(walk.yaw) * swayU,
    cy + eye - bounceU - stepSmooth,
    cz - Math.sin(walk.yaw) * swayU
  )
  perspCam.rotation.set(walk.pitch + Math.abs(Math.cos(wp - 0.2) * B) * 5 * RAD, walk.yaw, Math.sin(wp) * B * 3 * RAD, "YXZ")
  const fov = WALK_FOV * lerp(fovMod.old, fovMod.cur, pt)
  if (Math.abs(perspCam.fov - fov) > 0.01) {
    perspCam.fov = fov
    perspCam.updateProjectionMatrix()
  }
  // outline the interactable in reach (a touch larger than the model so it
  // doesn't z-fight); none while a modal has the controls detached
  perspCam.getWorldDirection(_look)
  const aim = state.suspended ? null : buildApi.aimDoor(perspCam.position.x, perspCam.position.y, perspCam.position.z, _look.x, _look.y, _look.z)
  if (aim) outline.show(aim)
  else outline.hide()
}

function enter() {
  if (state.on || locked.value || !buildApi.getRoot()) return
  const canvas = sceneApi.canvas
  if (!canvas) return
  ensureOutline()
  const perspCam = sceneApi.perspCam
  // walking is first-person: force back to perspective if ortho was on
  if (sceneApi.camera !== perspCam) sceneApi.setOrthoManual(false)
  state.on = true
  fly.on = false
  fly.speed = FLY_SPEED_DEFAULT
  noclip = false
  sceneApi.controls.enabled = false
  buildCollision()
  // start from where the camera is now (feet = eye - eye height), facing the
  // same way but level, snapped onto the ground
  const d = new THREE.Vector3()
  perspCam.getWorldDirection(d)
  walk.pos.set(perspCam.position.x, perspCam.position.y - EYE_STAND, perspCam.position.z)
  walk.yaw = Math.atan2(-d.x, -d.z)
  walk.pitch = 0
  walk.vel.set(0, 0, 0)
  walk.onGround = false
  walk.crouched = false
  walk.h = H_STAND
  walk.eye = EYE_STAND
  walk.eyeO = EYE_STAND
  jumpDelay = 0
  acc = 0
  // more than 10 blocks out from every floor grid: come in to the nearest
  // point on the closest one
  let best = null
  for (const r of sceneApi.getGridRects()) {
    const nx = Math.min(Math.max(walk.pos.x, r.x0), r.x1)
    const nz = Math.min(Math.max(walk.pos.z, r.z0), r.z1)
    const d2 = (walk.pos.x - nx) ** 2 + (walk.pos.z - nz) ** 2
    if (!best || d2 < best.d2) best = { nx, nz, d2 }
  }
  if (best && best.d2 > 160 * 160) {
    walk.pos.x = best.nx
    walk.pos.z = best.nz
  }
  bumpUp() // if we're buried in a block, lift to the first free space
  snapToGround()
  walk.prev.copy(walk.pos)
  bob.dist = 0
  bob.distO = 0
  bob.val = 0
  bob.valO = 0
  fovMod.cur = 1
  fovMod.old = 1
  stepSmooth = 0
  perspCam.fov = WALK_FOV
  perspCam.updateProjectionMatrix()
  // nothing in view from here (the edge arrow would show): face the centre
  perspCam.position.set(walk.pos.x, walk.pos.y + walk.eye, walk.pos.z)
  perspCam.rotation.set(walk.pitch, walk.yaw, 0, "YXZ")
  perspCam.updateMatrixWorld(true)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(perspCam.projectionMatrix, perspCam.matrixWorldInverse))
  if (!frustum.intersectsBox(sceneApi.sceneBounds())) {
    const c = sceneApi.sceneBounds().getCenter(new THREE.Vector3())
    walk.yaw = Math.atan2(-(c.x - perspCam.position.x), -(c.z - perspCam.position.z))
  }
  canvas.requestPointerLock()?.catch?.(() => {})
}

// a modal temporarily detaches the controls without leaving walk mode:
// pointer lock is released but the walk sim keeps owning the camera
function suspend() {
  if (!state.on || state.suspended) return
  state.suspended = true
  keys.clear()
  sprintW = false
  if (document.pointerLockElement === sceneApi.canvas) document.exitPointerLock()
}

// suspension lifts when the lock is actually re-acquired (see the
// pointerlockchange handler): the request can be denied without a fresh
// user gesture (Esc closing the modal), and the next canvas click retries
function resume() {
  if (!state.on || !state.suspended) return
  sceneApi.canvas.requestPointerLock()?.catch?.(() => {})
}

function exit() {
  if (!state.on) return
  const perspCam = sceneApi.perspCam
  state.on = false
  state.suspended = false
  noclip = false
  stopFlying()
  sceneApi.controls.enabled = true
  keys.clear()
  if (document.pointerLockElement === sceneApi.canvas) document.exitPointerLock()
  perspCam.fov = sceneApi.FOV
  perspCam.updateProjectionMatrix()
  // hand a clean pose back to OrbitControls: eye at the walk head, looking the
  // same way, with the orbit target a few blocks ahead. a target AT the eye is
  // degenerate (zero radius) and freezes the camera until "fit view"
  perspCam.position.set(walk.pos.x, walk.pos.y + walk.eye, walk.pos.z)
  perspCam.rotation.set(walk.pitch, walk.yaw, 0, "YXZ")
  perspCam.updateMatrixWorld(true)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(perspCam.projectionMatrix, perspCam.matrixWorldInverse))
  if (!frustum.intersectsBox(sceneApi.sceneBounds())) {
    // nothing in view (the edge arrow would show): aim at the scene centre
    const c = sceneApi.sceneBounds().getCenter(new THREE.Vector3())
    perspCam.lookAt(c)
    sceneApi.controls.target.copy(c)
  } else {
    const ahead = new THREE.Vector3()
    perspCam.getWorldDirection(ahead)
    sceneApi.controls.target.copy(perspCam.position).addScaledVector(ahead, 48)
  }
  sceneApi.updateProjection()
  sceneApi.controls.update()
  outline?.hide()
}

sceneApi.setWalkUpdate(dt => {
  if (!state.on) return false
  updateWalk(dt)
  return true
})

document.addEventListener("pointerlockchange", () => {
  if (!state.on) return
  if (document.pointerLockElement === sceneApi.canvas) state.suspended = false
  else if (!state.suspended) exit()
})
document.addEventListener("mousemove", e => {
  if (!state.on || document.pointerLockElement !== sceneApi.canvas) return
  walk.yaw -= e.movementX * 0.0024
  walk.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, walk.pitch - e.movementY * 0.0024))
})
addEventListener("keydown", e => {
  if (!state.on || state.suspended) return
  // without pointer lock the browser never sees Esc as "release the lock",
  // so it must exit walk mode directly or the mode is inescapable
  if (e.key === "Escape" && document.pointerLockElement !== sceneApi.canvas) {
    exit()
    return
  }
  e.preventDefault() // fully capture input: no ctrl+s / quick-find / space-scroll while walking
  if (e.code === "Space" && !e.repeat && !noclip) { // double-tap space toggles fly
    const t = performance.now()
    if (t - fly.lastSpace < DOUBLE_TAP) {
      if (fly.on) stopFlying() // momentum carries over: you just start falling
      else {
        fly.on = true
        // vanilla hops when flight starts on the ground
        if (walk.onGround) walk.vel.y = Math.max(JUMP, walk.vel.y)
        walk.onGround = false
      }
    }
    fly.lastSpace = t
  }
  if (e.code === "KeyW" && !e.repeat) { // double-tap W to sprint (until W released)
    const t = performance.now()
    if (t - lastW < DOUBLE_TAP) sprintW = true
    lastW = t
  }
  if (e.code === "KeyN" && !e.repeat) { // toggle noclip; fly.on is untouched, so
    noclip = !noclip                    // leaving noclip resumes flying (or falling) with momentum intact
    if (!noclip) {
      bumpUp() // leaving it inside a block: lift to the first free space
      walk.prev.copy(walk.pos)
      walk.onGround = false
      if (!fly.on) fly.speed = FLY_SPEED_DEFAULT // back to walking: the scroll speed resets
    }
  }
  keys.add(e.code)
}, { passive: false })
addEventListener("keyup", e => {
  if (!state.on || state.suspended) return
  e.preventDefault()
  if (e.code === "KeyW") sprintW = false
  keys.delete(e.code)
}, { passive: false })
// scroll while flying/noclip adjusts the fly speed exactly like spectator
// mode: 0.005 a notch, clamped 0..0.2 (default 0.05)
addEventListener("wheel", e => {
  if (!state.on || state.suspended || document.pointerLockElement !== sceneApi.canvas) return
  if (!fly.on && !noclip) return
  e.preventDefault()
  fly.speed = Math.min(Math.max(fly.speed + Math.sign(-e.deltaY) * 0.005, 0), 0.2)
}, { passive: false })
// click to interact: toggle the door/trapdoor/gate you're looking at, or
// open the loot modal for a container (detaching the controls until closed)
addEventListener("contextmenu", e => {
  if (state.on) e.preventDefault()
})
addEventListener("mousedown", e => {
  if (!state.on) return
  // suspended with the modal closed (Esc denied the relock): a click retries
  if (state.suspended) {
    if (!containerApi.state.open && document.pointerLockElement !== sceneApi.canvas) resume()
    return
  }
  if (document.pointerLockElement !== sceneApi.canvas) {
    // walking without the lock (the request failed or was denied): clicking
    // the canvas retakes it
    if (e.target === sceneApi.canvas) sceneApi.canvas.requestPointerLock()?.catch?.(() => {})
    return
  }
  e.preventDefault()
  const perspCam = sceneApi.perspCam
  const d = new THREE.Vector3()
  perspCam.getWorldDirection(d)
  const r = buildApi.interact(perspCam.position.x, perspCam.position.y, perspCam.position.z, d.x, d.y, d.z)
  if (r === true) buildCollision()
  else if (r?.entity) {
    suspend()
    containerApi.openEntity(r.entity)
  } else if (r) {
    suspend()
    containerApi.open(r)
  }
})

export function useWalk() {
  return {
    state: readonly(state),
    enter, exit, suspend, resume,
    toggle: () => state.on ? exit() : enter()
  }
}
