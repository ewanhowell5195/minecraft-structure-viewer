import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import sharp from "sharp"
import { writeZip } from "minecraft-asset-loader"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")
const configPath = path.join(here, "shots.json")
const cacheDir = path.join(here, ".cache")
const saves = path.join(process.env.APPDATA ?? "", ".minecraft", "saves")

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith("--")))
const base = (args.find(a => a.startsWith("--base="))?.slice(7) ?? "http://localhost:5183").replace(/\/$/, "")
const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
const names = args.filter(a => !a.startsWith("--"))
const t0 = performance.now()
const log = (...a) => console.log(`[shot ${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...a)

for (const name of names) if (!config[name]) throw new Error(`No shot named "${name}" in ${configPath}`)
if (flags.has("--pose") && names.length !== 1) throw new Error("--pose takes exactly one shot name")

async function worldZip(name, shot) {
  const out = path.join(cacheDir, `${name}.zip`)
  if (fs.existsSync(out) && !flags.has("--rezip")) return out
  const save = path.isAbsolute(shot.save) ? shot.save : path.join(saves, shot.save)
  const dim = path.join(save, "dimensions", "minecraft", shot.dimension)
  if (!fs.existsSync(dim)) throw new Error(`No ${shot.dimension} folder in ${save}`)
  log(`zipping ${save}`)
  const files = new Map([["level.dat", await fs.promises.readFile(path.join(save, "level.dat"))]])
  for (const entry of await fs.promises.readdir(dim, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath, entry.name)
    files.set(path.relative(save, full).split(path.sep).join("/"), await fs.promises.readFile(full))
  }
  await fs.promises.mkdir(cacheDir, { recursive: true })
  await fs.promises.writeFile(out, await writeZip(files, { compress: false }))
  return out
}

async function loadWorld(page, zip, shot) {
  log("opening the world")
  await page.goto(`${base}/app/?force`)
  await page.waitForFunction(() => window.__sv)
  await page.locator("input[type=file]").first().setInputFiles(zip)
  await page.waitForFunction(() => window.__sv.world.state.chunkCount && !window.__sv.world.state.busy, null, { timeout: 600000 })
  log("loading the chunks")
  await page.evaluate(params => {
    const p = new URLSearchParams(params)
    window.__sv.world.restoreLoad(p.get("wy"), p.get("wsel"), p.get("wdim"))
  }, shot.params)
  await page.waitForFunction(() => Array.from(document.querySelectorAll("body *")).some(e => !e.children.length && / · \d+ chunks · .* blocks/.test(e.textContent)), null, { timeout: 600000, polling: 500 })
  await page.waitForTimeout(2000)
}

function applyPose(page, shot) {
  return page.evaluate(({ camera, daytime }) => {
    const slider = Array.from(document.querySelectorAll("input[type=range]")).find(e => e.parentElement.textContent.includes("Daytime"))
    slider.value = daytime
    slider.dispatchEvent(new Event("input", { bubbles: true }))
    slider.dispatchEvent(new Event("change", { bubbles: true }))
    const origin = window.__sv.world.getLastSelection().worldOrigin
    const root = window.__sv.build.getRoot().position.toArray()
    const toScene = v => v.map((n, i) => (n - origin[i]) * 16 + root[i])
    const { camera: cam, controls } = window.__sv.scene
    cam.position.fromArray(toScene(camera.position))
    controls.target.fromArray(toScene(camera.target))
    controls.update()
  }, shot)
}

function readPose(page) {
  return page.evaluate(() => {
    const slider = Array.from(document.querySelectorAll("input[type=range]")).find(e => e.parentElement.textContent.includes("Daytime"))
    const origin = window.__sv.world.getLastSelection().worldOrigin
    const root = window.__sv.build.getRoot().position.toArray()
    const toWorld = v => v.toArray().map((n, i) => Math.round(((n - root[i]) / 16 + origin[i]) * 1000) / 1000)
    const { camera, controls } = window.__sv.scene
    const params = new URLSearchParams(location.search)
    params.delete("force")
    return { params: params.toString(), camera: { position: toWorld(camera.position), target: toWorld(controls.target) }, daytime: Number(slider.value) }
  })
}

async function waitForSave(page, shot) {
  await page.exposeFunction("__shotAlign", () => applyPose(page, shot))
  const saved = new Promise(resolve => page.exposeFunction("__shotSave", resolve))
  await page.evaluate(() => {
    const bar = document.createElement("div")
    bar.id = "shot-bar"
    bar.style.cssText = "position:fixed;left:50%;bottom:24px;translate:-50% 0;z-index:99999;display:flex;gap:8px"
    for (const [label, action] of [["Align camera", () => window.__shotAlign()], ["Save shot", () => window.__shotSave()]]) {
      const button = document.createElement("button")
      button.textContent = label
      button.style.cssText = "padding:12px 20px;font:600 15px system-ui;color:#fff;background:#3fa66a;border:0;border-radius:10px;cursor:pointer;user-select:none;box-shadow:0 4px 16px #0008"
      button.onclick = action
      bar.append(button)
    }
    document.body.append(bar)
  })
  await saved
  await page.evaluate(() => document.getElementById("shot-bar").remove())
}

function format(value) {
  return JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, inner) => `[${inner.split(/,\s+/).join(", ")}]`) + "\n"
}

async function shoot(page, shot) {
  await page.waitForTimeout(1500)
  const [x, y, width, height] = shot.clip
  const png = await page.screenshot({ clip: { x, y, width, height } })
  const out = path.join(root, shot.out)
  await fs.promises.mkdir(path.dirname(out), { recursive: true })
  await sharp(png).resize(shot.width).webp({ quality: shot.quality }).toFile(out)
  log(`wrote ${path.relative(root, out)}`)
}

const browser = await chromium.launch({ channel: "chrome", headless: false })
try {
  for (const name of names.length ? names : Object.keys(config)) {
    const shot = config[name]
    const zip = await worldZip(name, shot)
    const context = await browser.newContext({ viewport: { width: shot.viewport[0], height: shot.viewport[1] }, deviceScaleFactor: shot.scale })
    const page = await context.newPage()
    page.on("pageerror", error => log("page error:", error.message))
    await loadWorld(page, zip, shot)
    await applyPose(page, shot)
    if (flags.has("--pose")) {
      log("line up the shot, then click Save shot in the browser")
      await waitForSave(page, shot)
      Object.assign(shot, await readPose(page))
      await fs.promises.writeFile(configPath, format(config))
      log(`saved the pose to ${path.relative(root, configPath)}`)
    }
    await shoot(page, shot)
    await context.close()
  }
} finally {
  await browser.close()
}
