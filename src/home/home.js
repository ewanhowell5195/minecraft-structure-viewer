import { createStage } from "./stage.js"

const VILLAGE = "village"
const STEP_MS = 2000
const still = matchMedia("(prefers-reduced-motion: reduce)").matches

function wide() {
  return innerWidth > 900
}

function orbit(stage, canvas, spin, rate = 0.012) {
  const view = { pose: null, turned: 0 }
  const speed = { pitch: 0, distance: 0, target: [0, 0, 0], shift: [0, 0] }
  let from = null
  canvas.addEventListener("pointerdown", event => {
    from = event.clientX
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener("pointermove", event => {
    if (from === null) return
    view.turned -= (event.clientX - from) * 0.008
    from = event.clientX
  })
  for (const type of ["pointerup", "pointercancel"]) canvas.addEventListener(type, () => { from = null })
  stage.onFrame = (time, delta) => {
    if (!view.pose) return
    if (!still && from === null) view.turned += spin * delta / 1000
    const turn = 1 - Math.exp(-delta / 180)
    const fade = Math.exp(-rate * delta)
    const camera = stage.camera
    function settle(value, goal, velocity) {
      const offset = value - goal
      const lean = (velocity + rate * offset) * delta
      return [goal + (offset + lean) * fade, (velocity - rate * lean) * fade]
    }
    const [pitch, pitchSpeed] = settle(camera.pitch, view.pose.pitch, speed.pitch)
    const goal = view.fit ? view.fit(view.pose.yaw + view.turned) : view.pose
    const [distance, distanceSpeed] = settle(camera.distance, goal.distance, speed.distance)
    const target = camera.target.map((value, axis) => settle(value, goal.target[axis], speed.target[axis]))
    const shift = goal.shift ? camera.shift.map((value, axis) => settle(value, goal.shift[axis], speed.shift[axis])) : camera.shift.map(value => [value, 0])
    Object.assign(speed, { pitch: pitchSpeed, distance: distanceSpeed, target: target.map(pair => pair[1]), shift: shift.map(pair => pair[1]) })
    stage.setCamera({ yaw: camera.yaw + (view.pose.yaw + view.turned - camera.yaw) * turn, pitch, distance, target: target.map(pair => pair[0]), shift: shift.map(pair => pair[0]) })
  }
  return view
}

function heroStage(root, cleanup) {
  const canvas = root.querySelector('[data-stage="hero"]')
  const picks = Array.from(root.querySelectorAll("[data-model]"))
  const openLink = root.querySelector("[data-open-link]")
  const stage = createStage(canvas)
  cleanup.push(() => stage.dispose())
  const view = orbit(stage, canvas, 0.12)
  let showing = null

  function layout() {
    stage.setCamera({ shift: wide() ? [0.3, -0.06] : [0, -0.08] })
  }

  async function show(name, first) {
    showing = name
    const model = await stage.load(name)
    if (showing !== name) return
    canvas.classList.add("swap")
    await new Promise(done => setTimeout(done, view.pose ? 150 : 0))
    if (showing !== name) return
    const preferred = Number(picks.find(button => button.dataset.model === name)?.dataset.turn ?? 0) * Math.PI / 180
    await stage.show(name, Math.round(((first ? 0 : view.turned) - preferred) / (Math.PI / 2)))
    view.pose = { yaw: 0.75 + Math.PI / 4, pitch: 0.32, distance: model.fit * 1.2, target: [0, model.header.size[1] * 0.45, 0] }
    stage.setCamera(Object.assign({}, view.pose, { yaw: view.pose.yaw + view.turned }))
    canvas.classList.remove("swap")
  }

  function select(button, first = false) {
    for (const other of picks) other.setAttribute("aria-pressed", other === button)
    openLink.href = `/app/?${button.dataset.open}`
    return show(button.dataset.model, first)
  }

  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = picks[i]
    picks[i] = picks[j]
    picks[j] = swap
  }
  for (const button of picks) {
    button.parentElement.parentElement.append(button.parentElement)
    button.addEventListener("click", () => select(button))
  }
  layout()
  addEventListener("resize", layout)
  cleanup.push(() => removeEventListener("resize", layout))
  view.turned = -Math.PI / 4
  select(picks[0], true).then(() => {
    for (const button of picks) stage.load(button.dataset.model)
  })
}

function villageStage(root, cleanup) {
  const canvas = root.querySelector('[data-stage="village"]')
  const list = root.querySelector("[data-steps]")
  const stage = createStage(canvas)
  const view = orbit(stage, canvas, 0.05, 0.009)
  let model = null, buttons = [], step = -1, timer = 0, started = false, glide = null
  cleanup.push(() => {
    clearInterval(timer)
    stage.dispose()
  })

  function aim(yaw) {
    const end = stage.fit(Object.assign({}, view.pose, { yaw, level: glide.level }))
    if (!glide.from) return end
    const t = glide.length ? Math.min(1, (performance.now() - glide.start) / glide.length) : 1
    const k = t * t * (3 - 2 * t)
    const mix = (from, to) => from + (to - from) * k
    return { distance: mix(glide.from.distance, end.distance), target: glide.from.target.map((value, axis) => mix(value, end.target[axis])), shift: glide.from.shift.map((value, axis) => mix(value, end.shift[axis])) }
  }

  function pick(index) {
    const from = glide && aim(view.pose.yaw + view.turned)
    stage.grow(index, still)
    glide = { from, level: index, start: performance.now(), length: still ? 0 : stage.remaining() }
    step = index
    for (const button of buttons) button.setAttribute("aria-pressed", Number(button.dataset.step) === index)
  }

  function play() {
    clearInterval(timer)
    if (still) return pick(model.levels.length - 1)
    step = -1
    pick(0)
    timer = setInterval(() => {
      if (step === model.levels.length - 1) return clearInterval(timer)
      pick(step + 1)
    }, STEP_MS)
  }

  function steps() {
    const names = list.dataset.steps.split(",").map(Number)
    if (names.length !== model.levels.length) throw new Error(`home: data-steps names ${names.length} levels, the village model has ${model.levels.length}`)
    buttons = model.levels.map(({ blocks: count }, level) => {
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.step = level
      button.setAttribute("aria-pressed", "false")
      button.innerHTML = `<strong>Level ${names[level]}</strong><span>${count.toLocaleString("en-GB")} blocks</span>`
      button.addEventListener("click", () => {
        started = true
        clearInterval(timer)
        pick(level)
      })
      const item = document.createElement("li")
      item.append(button)
      list.append(item)
      return button
    })
  }

  async function prepare() {
    model = await stage.show(VILLAGE)
    steps()
    stage.grow(-1)
    glide = { from: null, level: -1 }
    view.pose = { yaw: 0.65, pitch: 0.62, height: 2, nearest: 22 }
    view.fit = aim
    stage.setCamera(Object.assign({ yaw: view.pose.yaw, pitch: view.pose.pitch }, aim(view.pose.yaw)))
  }

  function watch(options, run) {
    const observer = new IntersectionObserver((entries, watcher) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      watcher.disconnect()
      run()
    }, options)
    observer.observe(canvas)
    cleanup.push(() => observer.disconnect())
  }

  const ready = new Promise(done => watch({ rootMargin: "600px" }, () => done(prepare())))
  watch({ threshold: 0.6 }, async () => {
    await ready
    if (started) return
    started = true
    play()
  })
}

export function mountHome(root) {
  const cleanup = []
  const bar = root.querySelector(".bar")
  function updateBar() {
    bar.classList.toggle("scrolled", scrollY > 8)
  }
  addEventListener("scroll", updateBar, { passive: true })
  cleanup.push(() => removeEventListener("scroll", updateBar))
  updateBar()
  heroStage(root, cleanup)
  villageStage(root, cleanup)
  return () => {
    for (const run of cleanup) run()
  }
}
