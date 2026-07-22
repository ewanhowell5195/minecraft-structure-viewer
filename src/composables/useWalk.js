import { reactive, readonly } from "vue"
import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { useContainer } from "./useContainer.js"
import { useBooks } from "./useBooks.js"
import { useLock } from "./useLock.js"
import { useStream } from "./useStream.js"

// movement numbers are the vanilla ones throughout; world units: 16 = one block
const sceneApi = useScene()
const buildApi = useBuild()
const streamApi = useStream()
// streaming swaps the world queries (blocks, collision, aiming) to the tile provider
const wapi = () => streamApi.state.on ? streamApi.provider : buildApi
const containerApi = useContainer()
const { locked } = useLock()

const CLIMB = /(ladder|scaffolding)$|(^|:)vine$/
const PW = 4.8                                    // half-width (0.3 blocks)
// box height + eye, standing vs crouching (1.8/1.62 vs 1.5/1.27 blocks)
const H_STAND = 28.8, H_SNEAK = 24, EYE_STAND = 25.92, EYE_SNEAK = 20.32
const STEP = 9                                    // auto step-up (~half a block)
const WALK_FOV = 78
const DOUBLE_TAP = 350                            // minecraft's 7-tick window for double-tap sprint/fly
const NOLOCK = new URLSearchParams(location.search).has("nolock")

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
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0, onGround: false, crouched: false,
  h: H_STAND, eye: EYE_STAND, eyeO: EYE_STAND
}
// fly.on survives noclip, so leaving noclip resumes the prior mode
const fly = { on: false, speed: FLY_SPEED_DEFAULT, lastSpace: -1e9 }
let noclip = false
let sprintW = false, lastW = -1e9
let jumpDelay = 0                                 // vanilla noJumpDelay: held space re-jumps every 10 ticks
const bob = { dist: 0, distO: 0, val: 0, valO: 0 }
const fovMod = { cur: 1, old: 1 }
let stepSmooth = 0
let acc = 0
const keys = new Set()
let collCells = new Map(), floorY = 0

let outline = null
function ensureOutline() {
  outline ??= sceneApi.makeHighlight()
}

function buildCollision() {
  collCells = new Map()
  floorY = sceneApi.sceneBounds().min.y
}

function cellBoxes(ci, cj, ck) {
  const k = ci + "," + cj + "," + ck
  let a = collCells.get(k)
  if (a) return a
  a = []
  const p = wapi().getRoot()?.position
  if (p) {
    const lo = (c, o) => Math.floor((c * 16 - o - 8) / 16)
    const hi = (c, o) => Math.ceil(((c + 1) * 16 - o + 8) / 16)
    for (let gx = lo(ci, p.x); gx <= hi(ci, p.x); gx++)
      for (let gy = lo(cj, p.y); gy <= hi(cj, p.y); gy++)
        for (let gz = lo(ck, p.z); gz <= hi(ck, p.z); gz++) {
          const b = wapi().blockEntryAt(p.x + gx * 16, p.y + gy * 16, p.z + gz * 16)
          if (!b) continue
          for (const box of wapi().blockBoxes(b)) {
            if (box.px > ci * 16 && box.nx < ci * 16 + 16 &&
              box.py > cj * 16 && box.ny < cj * 16 + 16 &&
              box.pz > ck * 16 && box.nz < ck * 16 + 16) a.push(box)
          }
        }
  }
  collCells.set(k, a)
  return a
}

function updateCollision(blocks) {
  const p = wapi().getRoot()?.position
  if (!p) return
  const fc = v => Math.floor(v / 16)
  for (const b of blocks) {
    const nx = p.x + b.pos[0] * 16 - 8, ny = p.y + b.pos[1] * 16 - 8, nz = p.z + b.pos[2] * 16 - 8
    for (let ci = fc(nx); ci <= fc(nx + 16); ci++)
      for (let cj = fc(ny); cj <= fc(ny + 16); cj++)
        for (let ck = fc(nz); ck <= fc(nz + 16); ck++) collCells.delete(ci + "," + cj + "," + ck)
  }
}

const paabb = () => ({ nx: walk.pos.x - PW, px: walk.pos.x + PW, ny: walk.pos.y, py: walk.pos.y + walk.h, nz: walk.pos.z - PW, pz: walk.pos.z + PW })
const overlaps = (a, b) => !(a.px <= b.nx || a.nx >= b.px || a.py <= b.ny || a.ny >= b.py || a.pz <= b.nz || a.nz >= b.pz)

function nearby(a) {
  const set = new Set(), fc = v => Math.floor(v / 16)
  for (let ci = fc(a.nx); ci <= fc(a.px); ci++)
    for (let cj = fc(a.ny); cj <= fc(a.py); cj++)
      for (let ck = fc(a.nz); ck <= fc(a.pz); ck++) {
        for (const b of cellBoxes(ci, cj, ck)) set.add(b)
      }
  return set
}

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
// needs a FULL 2 blocks of clearance, not just the 1.8-tall player box
function roomToStand() {
  const b = { nx: walk.pos.x - PW, px: walk.pos.x + PW, ny: walk.pos.y, py: walk.pos.y + 32, nz: walk.pos.z - PW, pz: walk.pos.z + PW }
  for (const o of nearby(b)) if (overlaps(b, o)) return false
  return true
}
const bumpUp = () => { for (let i = 0; i < 4000 && !roomToStand(); i++) walk.pos.y += 2 }

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

function collideAxisOnce(ax, d) {
  // boxes we're already inside are ignored so we can walk out, not get flung across
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
  // back off 0.001: a flush snap can land a float ulp INSIDE the box, which then
  // counts as embedded and lets every later move pass through it
  if (corr !== null) walk.pos[ax] += corr - Math.sign(d) * 0.001
  return hit
}

// split big moves so a thin wall can't be teleported through
function collideAxis(ax, d) {
  if (!d) return false
  const n = Math.ceil(Math.abs(d) / 8)
  for (let i = 0; i < n; i++) if (collideAxisOnce(ax, d / n)) return true
  return false
}

// true when the move ended against a wall, like vanilla's horizontalCollision
function stepMove(ax, d, grounded) {
  if (!d) return false
  const y0 = walk.pos.y, p0 = walk.pos[ax]
  if (!collideAxis(ax, d)) return false
  if (!grounded || walk.vel.y > 0) return true
  const snapped = walk.pos[ax]
  walk.pos[ax] = p0
  // clip the lift against ceilings over the current AND target footprint (vanilla's
  // expandTowards collide): a low doorway steps with whatever headroom exists
  const probe = paabb()
  if (ax === "x") { if (d > 0) probe.px += d; else probe.nx += d }
  else { if (d > 0) probe.pz += d; else probe.nz += d }
  let lift = STEP
  for (const b of nearby({ ...probe, py: probe.py + STEP })) {
    if (b.px <= probe.nx || b.nx >= probe.px || b.pz <= probe.nz || b.nz >= probe.pz) continue
    if (b.ny >= probe.py - 0.001) lift = Math.min(lift, b.ny - probe.py - 0.001)
  }
  walk.pos.y = y0 + Math.max(lift, 0)
  if (walk.pos.y > y0 + 0.01 && !collideAxis(ax, d) && !isStuck()) {
    if (collideAxis("y", y0 - walk.pos.y)) walk.onGround = true
    walk.vel.y = 0
    // prev.y follows so the partial-tick lerp doesn't replay the step on top of
    // stepSmooth: both at once dips the camera on every stair
    const raise = walk.pos.y - y0
    walk.prev.y += raise
    stepSmooth = Math.min(STEP, stepSmooth + raise)
    return false
  }
  walk.pos.y = y0
  walk.pos[ax] = snapped
  return true
}

// probing a whole step down lets sneak walk down slabs while still guarding real drops
function supported() {
  if (walk.pos.y <= floorY + 1) return true
  const a = paabb(), probe = { nx: a.nx, px: a.px, ny: walk.pos.y - STEP, py: walk.pos.y, nz: a.nz, pz: a.pz }
  for (const b of nearby(probe)) if (overlaps(probe, b)) return true
  return false
}

const WATER_FLUID = /(^|:)(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
const LAVA_FLUID = /(^|:)lava$/
function fluidOf(b) {
  if (!b) return null
  const name = b.Name || ""
  if (LAVA_FLUID.test(name)) return "lava"
  if (WATER_FLUID.test(name) || b.Properties?.waterlogged === "true") return "water"
  return null
}

// vanilla picks the travel branch from the fluid in the feet block; height is the
// fluid surface above the feet in blocks (source = 8/9, falling/waterlogged = full)
function fluidState() {
  const fy = walk.pos.y + 0.1
  const b = wapi().blockAt(walk.pos.x, fy, walk.pos.z)
  const type = fluidOf(b)
  if (!type) return null
  const p = wapi().getRoot()?.position
  if (!p) return null
  const bottom = p.y + Math.round((fy - p.y) / 16) * 16 - 8
  let top
  if (fluidOf(wapi().blockAt(walk.pos.x, bottom + 24, walk.pos.z)) === type) {
    top = bottom + 32
  } else {
    const level = /(^|:)(water|lava)$/.test(b.Name || "") ? Number(b.Properties?.level ?? 0) : 0
    top = bottom + (level === 0 ? 8 / 9 : level >= 8 ? 1 : (8 - level) / 9) * 16
  }
  if (top <= walk.pos.y) return null
  return { type, height: (top - walk.pos.y) / 16 }
}

// clearance for the climb-out hop: the box lifted 0.6 blocks toward the move
function canClimbOut(vx, vz) {
  const a = paabb()
  const b = { nx: a.nx + vx, px: a.px + vx, ny: a.ny + 9.6, py: a.py + 9.6, nz: a.nz + vz, pz: a.pz + vz }
  for (const o of nearby(b)) if (overlaps(b, o)) return false
  return true
}

// the low sample sits just above the feet so you keep climbing until they clear the top block
function onClimbable() {
  for (const y of [walk.pos.y + 1, walk.pos.y + walk.h * 0.5]) {
    const b = wapi().blockAt(walk.pos.x, y, walk.pos.z)
    if (b && CLIMB.test(b.Name || "")) return true
  }
  return false
}

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

// vanilla input pipeline: the scale-up toward the unit square keeps diagonals full speed
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

  // stay crouched under a low ceiling; the eye eases at minecraft's 0.5/tick
  walk.crouched = !flying && (sneakKey || (walk.crouched && !canStand()))
  walk.h = walk.crouched ? H_SNEAK : H_STAND
  walk.eye += ((walk.crouched ? EYE_SNEAK : EYE_STAND) - walk.eye) * 0.5

  const sprint = sprintKey && fwdKey && !walk.crouched
  const fluidNow = flying ? null : fluidState()

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
    // vanilla flight: 3x-speed vertical impulse, horizontal doubled while sprinting
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
  } else if (fluidNow) {
    // vanilla travelInFluid: 0.02 accel; water drags 0.8 (0.9 sprinting) with
    // gravity/16, lava 0.5 (all axes when deep) plus gravity/4; space rises 0.04
    // in deep fluid but jumps for real when grounded in a shallow one; sneak
    // sinks in water only; hitting a wall with clearance hops out at 0.3
    const water = fluidNow.type === "water"
    const grounded = walk.onGround
    const shallow = fluidNow.height <= 0.4
    if (jumpDelay > 0) jumpDelay--
    if (!keys.has("Space")) jumpDelay = 0
    else if (!(grounded && shallow)) {
      walk.vel.y += 0.04 * 16
    } else if ((grounded || (water && shallow)) && jumpDelay === 0) {
      walk.vel.y = Math.max(JUMP, walk.vel.y)
      jumpDelay = 10
    }
    if (water && sneakKey) walk.vel.y -= 0.04 * 16
    // vanilla swim-pitch (aiStep): moving forward pulls vertical velocity toward
    // the look direction, diving freely but only pulling upward while submerged
    if (water && fwdKey) {
      const lookY = Math.sin(walk.pitch)
      const submerged = fluidOf(wapi().blockAt(walk.pos.x, walk.pos.y + 14.4, walk.pos.z)) === "water"
      if (lookY <= 0 || keys.has("Space") || submerged) {
        walk.vel.y += (lookY * 16 - walk.vel.y) * (lookY < -0.2 ? 0.085 : 0.06)
      }
    }
    const a = 16 * 0.02
    walk.vel.x += inX * a
    walk.vel.z += inZ * a
    walk.onGround = false
    const hitX = moveGround("x", walk.vel.x, grounded, false)
    const hitZ = moveGround("z", walk.vel.z, grounded, false)
    if (hitX) walk.vel.x = 0
    if (hitZ) walk.vel.z = 0
    if (collideAxis("y", walk.vel.y)) {
      if (walk.vel.y < 0) walk.onGround = true
      walk.vel.y = 0
    }
    if ((hitX || hitZ) && onClimbable()) walk.vel.y = 0.2 * 16
    if (water) {
      const slow = sprint ? 0.9 : 0.8
      walk.vel.x *= slow
      walk.vel.z *= slow
      walk.vel.y *= 0.8
      if (!sprint) walk.vel.y -= GRAVITY / 16
    } else if (shallow) {
      walk.vel.x *= 0.5
      walk.vel.z *= 0.5
      walk.vel.y *= 0.8
      if (!sprint) walk.vel.y -= GRAVITY / 16
      walk.vel.y -= GRAVITY / 4
    } else {
      walk.vel.multiplyScalar(0.5)
      walk.vel.y -= GRAVITY / 4
    }
    if ((hitX || hitZ) && canClimbOut(walk.vel.x, walk.vel.z)) walk.vel.y = 0.3 * 16
  } else {
    const grounded = walk.onGround // pre-move contact drives accel, drag and step-up, like vanilla
    const climbing = onClimbable()
    if (jumpDelay > 0) jumpDelay--
    if (!keys.has("Space")) jumpDelay = 0
    else if (grounded && jumpDelay === 0) {
      walk.vel.y = Math.max(JUMP, walk.vel.y)
      if (sprint) {
        walk.vel.x += fwd.x * SPRINT_JUMP_BOOST
        walk.vel.z += fwd.z * SPRINT_JUMP_BOOST
      }
      jumpDelay = 10
    }
    // divergence: ladders get full ground accel for playability; the vanilla
    // handleOnClimbable clamp keeps the resulting speeds accurate anyway
    const a = 16 * (grounded || climbing
      ? WALK_SPEED * (sprint ? SPRINT_MOD : 1)
      : sprint ? AIR_ACCEL_SPRINT : AIR_ACCEL)
    walk.vel.x += inX * a
    walk.vel.z += inZ * a
    if (climbing) {
      walk.vel.x = Math.max(-2.4, Math.min(2.4, walk.vel.x))
      walk.vel.z = Math.max(-2.4, Math.min(2.4, walk.vel.z))
      walk.vel.y = Math.max(walk.vel.y, -2.4)
      if (walk.crouched && walk.vel.y < 0 && !/scaffolding$/.test(wapi().blockAt(walk.pos.x, walk.pos.y + 1, walk.pos.z)?.Name || "")) walk.vel.y = 0
    }
    walk.onGround = false
    // guard within a step of ground, not only grounded: stair-step falls must not slip off edges
    const edgeGuard = sneakKey && walk.vel.y <= 0 && (grounded || supported())
    const hitX = moveGround("x", walk.vel.x, grounded, edgeGuard)
    const hitZ = moveGround("z", walk.vel.z, grounded, edgeGuard)
    if (hitX) walk.vel.x = 0
    if (hitZ) walk.vel.z = 0
    const yBefore = walk.pos.y
    if (collideAxis("y", walk.vel.y)) {
      if (walk.vel.y < 0) {
        walk.onGround = true
        // vanilla restitution: the getOnPosLegacy block 0.2 below the feet (so
        // carpets on slime still bounce but slabs mask it), only above one
        // gravity tick of fall speed, suppressed by sneaking; the formula
        // pre-compensates for the gravity and drag the travel step applies next
        const below = wapi().blockAt(walk.pos.x, walk.pos.y - 3.2, walk.pos.z)
        const name = (below?.Name || "").replace(/^minecraft:/, "")
        const restitution = name === "slime_block" ? 1 : /_bed$/.test(name) ? 0.75 : 0
        if (restitution > 0 && !sneakKey && -walk.vel.y > GRAVITY) {
          const portion = Math.min(Math.max((yBefore - walk.pos.y) / -walk.vel.y, 0), 1)
          walk.vel.y = (portion * GRAVITY - walk.vel.y) * (1 + portion * (VERT_DRAG - 1)) * restitution
        } else {
          walk.vel.y = 0
        }
      } else {
        walk.vel.y = 0
      }
    }
    // vanilla: pushing into the ladder or holding jump climbs at 0.2
    if ((hitX || hitZ || keys.has("Space")) && climbing) walk.vel.y = 0.2 * 16
    // vanilla travelInAir order; ladders get ground drag to pair with their ground accel
    const drag = grounded || climbing ? GROUND_DRAG : AIR_DRAG
    walk.vel.x *= drag
    walk.vel.z *= drag
    walk.vel.y = (walk.vel.y - GRAVITY) * VERT_DRAG
  }

  // eased 0.5/tick and clamped like vanilla's Camera.tickFov
  let target = 1
  if (flying) target *= 1.1
  target *= ((sprint ? SPRINT_MOD : 1) + 1) / 2
  fovMod.cur = Math.min(Math.max(fovMod.cur + (target - fovMod.cur) * 0.5, 0.1), 1.5)

  // vanilla view-bob numbers (walkDist in blocks)
  bob.dist += Math.hypot(walk.pos.x - walk.prev.x, walk.pos.z - walk.prev.z) / 16 * 0.6
  const bobTarget = (!flying && walk.onGround) ? Math.min(0.1, Math.hypot(walk.vel.x, walk.vel.z) / 16) : 0
  bob.val += (bobTarget - bob.val) * 0.4
}

const _look = new THREE.Vector3()
const lerp = (a, b, t) => a + (b - a) * t

function updateWalk(dt) {
  if (streamApi.state.on) streamApi.tick(walk.pos)
  acc += Math.min(dt, 0.25)
  let n = 0
  while (acc >= TICK && n++ < 10) {
    acc -= TICK
    tickSim()
  }
  if (acc >= TICK) acc = 0 // heavy lag: drop the leftover instead of spiralling
  const pt = acc / TICK
  const perspCam = sceneApi.perspCam
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
  perspCam.getWorldDirection(_look)
  const aim = state.suspended ? null : wapi().aimDoor(perspCam.position.x, perspCam.position.y, perspCam.position.z, _look.x, _look.y, _look.z)
  if (aim) outline.show(aim)
  else outline.hide()
}

// ctrl+W (sprint + forward) instantly closes the tab otherwise; browsers reserve
// the shortcut, so a leave-confirmation prompt is the only available guard. The
// pointer must be released or the dialog can't be clicked; if the user cancels,
// the page keeps running and the retry relocks (or the next canvas click does)
const unloadGuard = e => {
  e.preventDefault()
  e.returnValue = ""
  if (document.pointerLockElement === sceneApi.canvas) {
    suspend()
    setTimeout(() => resume(), 250)
  }
}

function enter() {
  if (state.on || locked.value || !wapi().getRoot()) return
  const canvas = sceneApi.canvas
  if (!canvas) return
  ensureOutline()
  const perspCam = sceneApi.perspCam
  if (sceneApi.camera !== perspCam) sceneApi.setOrthoManual(false)
  state.on = true
  useBooks().setRange(3)
  fly.on = false
  fly.speed = FLY_SPEED_DEFAULT
  noclip = false
  sceneApi.controls.enabled = false
  buildCollision()
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
  // more than 10 blocks out from every floor grid: pull in to the nearest one
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
  bumpUp()
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
  addEventListener("beforeunload", unloadGuard)
  if (!NOLOCK) canvas.requestPointerLock()?.catch?.(() => {})
}

function suspend() {
  if (!state.on || state.suspended) return
  state.suspended = true
  keys.clear()
  sprintW = false
  if (document.pointerLockElement === sceneApi.canvas) document.exitPointerLock()
}

// suspension lifts on pointerlockchange: the relock can be denied without a fresh
// user gesture (Esc closing the modal), and the next canvas click retries
function resume() {
  if (!state.on || !state.suspended) return
  if (NOLOCK) { state.suspended = false; return }
  sceneApi.canvas.requestPointerLock()?.catch?.(() => {})
}

function exit() {
  if (!state.on) return
  const streaming = streamApi.state.on
  removeEventListener("beforeunload", unloadGuard)
  const perspCam = sceneApi.perspCam
  state.on = false
  state.suspended = false
  useBooks().setRange(16)
  noclip = false
  stopFlying()
  sceneApi.controls.enabled = true
  keys.clear()
  if (document.pointerLockElement === sceneApi.canvas) document.exitPointerLock()
  perspCam.fov = sceneApi.FOV
  perspCam.updateProjectionMatrix()
  // an orbit target AT the eye is degenerate (zero radius) and freezes the camera
  perspCam.position.set(walk.pos.x, walk.pos.y + walk.eye, walk.pos.z)
  perspCam.rotation.set(walk.pitch, walk.yaw, 0, "YXZ")
  perspCam.updateMatrixWorld(true)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(perspCam.projectionMatrix, perspCam.matrixWorldInverse))
  if (!frustum.intersectsBox(sceneApi.sceneBounds())) {
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
  if (streaming) streamApi.exit({ x: walk.pos.x, y: walk.pos.y + walk.eye, z: walk.pos.z, pitch: walk.pitch, yaw: walk.yaw })
}

streamApi.setTilesChanged(() => { collCells = new Map() })

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
  // without pointer lock the browser never sees Esc, so exit directly or the mode is inescapable
  if (e.key === "Escape" && document.pointerLockElement !== sceneApi.canvas) {
    exit()
    return
  }
  e.preventDefault() // capture all input while walking
  if (e.code === "Space" && !e.repeat && !noclip) {
    const t = performance.now()
    if (t - fly.lastSpace < DOUBLE_TAP) {
      if (fly.on) stopFlying()
      else {
        fly.on = true
        // vanilla hops when flight starts on the ground
        if (walk.onGround) walk.vel.y = Math.max(JUMP, walk.vel.y)
        walk.onGround = false
      }
    }
    fly.lastSpace = t
  }
  if (e.code === "KeyW" && !e.repeat) {
    const t = performance.now()
    if (t - lastW < DOUBLE_TAP) sprintW = true
    lastW = t
  }
  if (e.code === "KeyN" && !e.repeat) {
    noclip = !noclip
    if (!noclip) {
      bumpUp()
      walk.prev.copy(walk.pos)
      walk.onGround = false
      if (!fly.on) fly.speed = FLY_SPEED_DEFAULT
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
// fly speed scroll, exactly spectator mode's: 0.005 a notch, clamped 0..0.2
addEventListener("wheel", e => {
  if (!state.on || state.suspended || (!NOLOCK && document.pointerLockElement !== sceneApi.canvas)) return
  if (!fly.on && !noclip) return
  e.preventDefault()
  fly.speed = Math.min(Math.max(fly.speed + Math.sign(-e.deltaY) * 0.005, 0), 0.2)
}, { passive: false })
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
  if (!NOLOCK && document.pointerLockElement !== sceneApi.canvas) {
    if (e.target === sceneApi.canvas) sceneApi.canvas.requestPointerLock()?.catch?.(() => {})
    return
  }
  e.preventDefault()
  const perspCam = sceneApi.perspCam
  const d = new THREE.Vector3()
  perspCam.getWorldDirection(d)
  const r = wapi().interact(perspCam.position.x, perspCam.position.y, perspCam.position.z, d.x, d.y, d.z)
  if (r?.toggled) updateCollision(r.toggled)
  else if (r?.entity) {
    suspend()
    containerApi.openEntityMarker(r.entity)
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
