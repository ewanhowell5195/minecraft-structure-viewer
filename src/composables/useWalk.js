import { reactive, readonly } from "vue"
import * as THREE from "three"
import { useScene } from "./useScene.js"
import { useBuild } from "./useBuild.js"
import { useContainer } from "./useContainer.js"
import { useLock } from "./useLock.js"

// First-person walk-around: a pointer-locked FPS camera with gravity, AABB
// collision against every rendered block (stairs/slabs walkable) + the ground
// plane, auto step-up, sneak edge-guard, double-tap fly, and view bobbing.
// World units: 16 = one block. Constants matched to Minecraft.
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

const state = reactive({ on: false, suspended: false })

const walk = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, onGround: false, crouched: false, h: H_STAND, eye: EYE_STAND }
const fly = { on: false, lastSpace: -1e9 }
let noclip = false
let sprintW = false, lastW = -1e9                 // double-tap W latches sprint until W is released
const bob = { dist: 0, val: 0, px: 0, pz: 0 }     // minecraft view-bob: walkDist, smoothed speed, last pos
let stepSmooth = 0                                // camera lag after an auto step-up, eased out like MC
const keys = new Set()
let collHash = new Map(), floorY = 0

// outline round the door currently in reach (minecraft-style block highlight)
const aimBox = new THREE.Box3()
let outline = null
function ensureOutline() {
  if (outline) return
  outline = new THREE.Box3Helper(aimBox, 0x000000)
  outline.material.transparent = true
  outline.material.opacity = 0.5
  outline.visible = false
  sceneApi.scene.add(outline)
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

// move one axis by d, then snap out of the deepest overlapping box / the floor
function collideAxis(ax, d) {
  if (!d) return false
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
  if (corr !== null) walk.pos[ax] += corr
  return hit
}

// horizontal move with auto step-up: if blocked, try lifting by STEP and going
// again, then settle onto the ledge (so slabs/stairs don't need a jump)
function stepMove(ax, d, grounded) {
  if (!d) return
  const y0 = walk.pos.y, p0 = walk.pos[ax]
  // only auto-climb while standing on something (not mid-air / mid-jump)
  if (!collideAxis(ax, d) || fly.on || !grounded || walk.vel.y > 0) return
  const snapped = walk.pos[ax]
  walk.pos[ax] = p0
  walk.pos.y = y0 + STEP
  // stepped up ok: settle onto the ledge and stay grounded (so a staircase
  // keeps climbing frame after frame); otherwise too tall, stay put
  if (!collideAxis(ax, d) && !isStuck()) {
    if (collideAxis("y", -STEP)) walk.onGround = true
    walk.vel.y = 0
    stepSmooth = Math.min(STEP, stepSmooth + walk.pos.y - y0)
  } else {
    walk.pos.y = y0
    walk.pos[ax] = snapped
  }
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
  if (!d) return
  const px = walk.pos.x, py = walk.pos.y, pz = walk.pos.z
  stepMove(ax, d, grounded)
  if (edgeGuard && !supported()) walk.pos.set(px, py, pz)
}

const _look = new THREE.Vector3()

function updateWalk(dt) {
  dt = Math.min(dt, 0.05)
  const perspCam = sceneApi.perspCam
  const sprint = keys.has("ControlLeft") || keys.has("ControlRight") || keys.has("KeyQ") || sprintW
  if (noclip) {
    // free camera: move along where you look (pitch included), no gravity/collision
    const sp = sprint ? 260 : 140
    const look = new THREE.Vector3(-Math.sin(walk.yaw) * Math.cos(walk.pitch), Math.sin(walk.pitch), -Math.cos(walk.yaw) * Math.cos(walk.pitch))
    const rgtN = new THREE.Vector3(Math.cos(walk.yaw), 0, -Math.sin(walk.yaw))
    const m = new THREE.Vector3()
    if (keys.has("KeyW")) m.add(look)
    if (keys.has("KeyS")) m.sub(look)
    if (keys.has("KeyD")) m.add(rgtN)
    if (keys.has("KeyA")) m.sub(rgtN)
    if (m.lengthSq()) walk.pos.addScaledVector(m.normalize(), sp * dt)
    walk.vel.set(0, 0, 0)
    walk.onGround = false
    walk.crouched = false
    walk.h = H_STAND
    walk.eye = EYE_STAND
  } else {
    const sneak = keys.has("ShiftLeft") || keys.has("ShiftRight")
    // crouch shrinks the hitbox (1.8 -> 1.5); if a low ceiling blocks standing
    // back up, stay crouched until there's headroom
    walk.crouched = (sneak && !fly.on) || (walk.crouched && !canStand())
    walk.h = walk.crouched ? H_SNEAK : H_STAND
    walk.eye = walk.crouched ? EYE_SNEAK : EYE_STAND
    const fwd = new THREE.Vector3(-Math.sin(walk.yaw), 0, -Math.cos(walk.yaw))
    const rgt = new THREE.Vector3(Math.cos(walk.yaw), 0, -Math.sin(walk.yaw))
    const dir = new THREE.Vector3()
    if (keys.has("KeyW")) dir.add(fwd)
    if (keys.has("KeyS")) dir.sub(fwd)
    if (keys.has("KeyD")) dir.add(rgt)
    if (keys.has("KeyA")) dir.sub(rgt)
    if (dir.lengthSq()) dir.normalize()
    if (fly.on) {
      const sp = sprint ? 260 : 140
      let vy = 0
      if (keys.has("Space")) vy += 1
      if (sneak) vy -= 1
      collideAxis("x", dir.x * sp * dt)
      collideAxis("z", dir.z * sp * dt)
      collideAxis("y", vy * sp * dt)
      walk.vel.set(0, 0, 0)
      walk.onGround = false
    } else {
      const grounded = walk.onGround // last frame's contact: stepMove needs it before the reset below
      const sp = walk.crouched ? 26 : sprint ? 118 : 78 // ~1.6 / 7.4 / 4.9 blocks/s
      walk.vel.x = dir.x * sp
      walk.vel.z = dir.z * sp
      // on a ladder/vine: no gravity, W climbs up, S down, sneak holds, else slide
      if (onClimbable() && !(keys.has("Space") && grounded)) {
        walk.vel.y = walk.crouched ? 0 : keys.has("KeyW") ? 48 : keys.has("KeyS") ? -48 : -18
      } else {
        walk.vel.y -= 520 * dt
        if (keys.has("Space") && grounded) walk.vel.y = 134
      }
      walk.onGround = false
      // sneak keeps you on the surface even mid-step: guard while within a step
      // of ground (not only when strictly grounded), so you can't slip off an
      // edge during the little fall between stair steps
      const edgeGuard = sneak && walk.vel.y <= 0 && (grounded || supported())
      moveGround("x", walk.vel.x * dt, grounded, edgeGuard)
      moveGround("z", walk.vel.z * dt, grounded, edgeGuard)
      const hitY = collideAxis("y", walk.vel.y * dt)
      if (hitY) {
        if (walk.vel.y < 0) walk.onGround = true
        walk.vel.y = 0
      }
    }
  }
  // view bobbing, matching minecraft's GameRenderer.bobView: walkDist advances
  // the phase (horizontal distance x 0.6, in blocks), bob is the smoothed
  // horizontal speed (0..0.1) and scales the amplitude
  const movedBlocks = Math.hypot(walk.pos.x - bob.px, walk.pos.z - bob.pz) / 16
  bob.px = walk.pos.x
  bob.pz = walk.pos.z
  bob.dist += movedBlocks * 0.6
  const bobTarget = (!fly.on && walk.onGround) ? Math.min(0.1, dt > 0 ? movedBlocks / (dt * 20) : 0) : 0
  bob.val += (bobTarget - bob.val) * (1 - Math.pow(0.6, dt / 0.05)) // minecraft's 0.4-per-tick lerp
  const wp = bob.dist * Math.PI, B = bob.val, RAD = Math.PI / 180
  const swayU = Math.sin(wp) * B * 0.5 * 16, bounceU = Math.abs(Math.cos(wp) * B) * 16
  // ease the eye up after a step-up instead of snapping (like MC's per-tick lerp)
  stepSmooth *= Math.pow(0.5, dt / 0.045)
  if (stepSmooth < 0.05) stepSmooth = 0
  perspCam.position.set(
    walk.pos.x + Math.cos(walk.yaw) * swayU,
    walk.pos.y + walk.eye - bounceU - stepSmooth,
    walk.pos.z - Math.sin(walk.yaw) * swayU
  )
  perspCam.rotation.set(walk.pitch + Math.abs(Math.cos(wp - 0.2) * B) * 5 * RAD, walk.yaw, Math.sin(wp) * B * 3 * RAD, "YXZ")
  // outline the interactable in reach (a touch larger than the model so it
  // doesn't z-fight); none while a modal has the controls detached
  perspCam.getWorldDirection(_look)
  const aim = state.suspended ? null : buildApi.aimDoor(perspCam.position.x, perspCam.position.y, perspCam.position.z, _look.x, _look.y, _look.z)
  if (aim) {
    aimBox.copy(aim).expandByScalar(0.2)
    outline.visible = true
  } else outline.visible = false
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
  noclip = false
  sceneApi.controls.enabled = false
  buildCollision()
  // start from where the camera is now (feet = eye - eye height), looking the
  // same way
  const d = new THREE.Vector3()
  perspCam.getWorldDirection(d)
  walk.pos.set(perspCam.position.x, perspCam.position.y - EYE_STAND, perspCam.position.z)
  walk.yaw = Math.atan2(-d.x, -d.z)
  walk.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, Math.asin(Math.max(-1, Math.min(1, d.y)))))
  walk.vel.set(0, 0, 0)
  walk.onGround = false
  walk.crouched = false
  walk.h = H_STAND
  walk.eye = EYE_STAND
  bumpUp() // if that left us buried in a block, lift to the first free space
  bob.dist = 0
  bob.val = 0
  bob.px = walk.pos.x
  bob.pz = walk.pos.z
  stepSmooth = 0
  perspCam.fov = WALK_FOV
  perspCam.updateProjectionMatrix()
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

function resume() {
  if (!state.on || !state.suspended) return
  state.suspended = false
  sceneApi.canvas.requestPointerLock()?.catch?.(() => exit())
}

function exit() {
  if (!state.on) return
  const perspCam = sceneApi.perspCam
  state.on = false
  state.suspended = false
  noclip = false
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
  const ahead = new THREE.Vector3()
  perspCam.getWorldDirection(ahead)
  sceneApi.controls.target.copy(perspCam.position).addScaledVector(ahead, 48)
  sceneApi.updateProjection()
  sceneApi.controls.update()
  if (outline) outline.visible = false
}

sceneApi.setWalkUpdate(dt => {
  if (!state.on) return false
  updateWalk(dt)
  return true
})

document.addEventListener("pointerlockchange", () => {
  if (state.on && !state.suspended && document.pointerLockElement !== sceneApi.canvas) exit()
})
document.addEventListener("mousemove", e => {
  if (!state.on || document.pointerLockElement !== sceneApi.canvas) return
  walk.yaw -= e.movementX * 0.0024
  walk.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, walk.pitch - e.movementY * 0.0024))
})
addEventListener("keydown", e => {
  if (!state.on || state.suspended) return
  e.preventDefault() // fully capture input: no ctrl+s / quick-find / space-scroll while walking
  if (e.code === "Space" && !e.repeat) { // double-tap space toggles fly
    const t = performance.now()
    if (t - fly.lastSpace < DOUBLE_TAP) { fly.on = !fly.on; walk.vel.set(0, 0, 0) }
    fly.lastSpace = t
  }
  if (e.code === "KeyW" && !e.repeat) { // double-tap W to sprint (until W released)
    const t = performance.now()
    if (t - lastW < DOUBLE_TAP) sprintW = true
    lastW = t
  }
  if (e.code === "KeyN" && !e.repeat) { // toggle noclip; leaving it, bump out of any block
    noclip = !noclip
    if (noclip) { fly.on = false; walk.vel.set(0, 0, 0) }
    else { bumpUp(); walk.vel.set(0, 0, 0); walk.onGround = false }
  }
  keys.add(e.code)
}, { passive: false })
addEventListener("keyup", e => {
  if (!state.on || state.suspended) return
  e.preventDefault()
  if (e.code === "KeyW") sprintW = false
  keys.delete(e.code)
}, { passive: false })
// click to interact: toggle the door/trapdoor/gate you're looking at, or
// open the loot modal for a container (detaching the controls until closed)
addEventListener("mousedown", e => {
  if (!state.on || state.suspended || document.pointerLockElement !== sceneApi.canvas) return
  e.preventDefault()
  const perspCam = sceneApi.perspCam
  const d = new THREE.Vector3()
  perspCam.getWorldDirection(d)
  const r = buildApi.interact(perspCam.position.x, perspCam.position.y, perspCam.position.z, d.x, d.y, d.z)
  if (r === true) buildCollision()
  else if (r) {
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
