<template>
  <div ref="root" class="home" @click="follow">
    <header class="bar">
      <a class="brand" href="/"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 2.6 20.2 7.3v9.4L12 21.4l-8.2-4.7V7.3z M3.8 7.3 12 12l8.2-4.7 M12 12v9.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>Structure Viewer</a>
      <a class="button primary" href="/app/">Open the viewer</a>
    </header>

    <main>
      <section class="hero">
        <canvas class="stage" data-stage="hero" aria-label="A Minecraft structure in 3D. Drag to turn it."></canvas>
        <div class="hero-copy">
          <h1>Every Minecraft structure, in 3D, in your browser</h1>
          <p class="lead">View every structure and worldgen feature in the game, and watch how they generate. You can also load your own worlds, builds, and packs!</p>
          <a class="button primary big" href="/app/">Open the viewer</a>
        </div>
        <div class="shelf">
          <p class="shelf-title">Try one</p>
          <ul class="picks">
            <li><button type="button" data-model="camp" data-turn="90" data-open="structure=minecraft/abandoned_camp/tent/bamboo_jungle/tent_bamboo_jungle_2&seed=24&level=3" aria-pressed="true">abandoned_camp/bamboo_jungle</button></li>
            <li><button type="button" data-model="outpost" data-open="structure=minecraft/pillager_outpost/watchtower" aria-pressed="false">pillager_outpost/watchtower</button></li>
            <li><button type="button" data-model="portal" data-open="structure=minecraft/ruined_portal/giant_portal_1" aria-pressed="false">ruined_portal/giant_portal_1</button></li>
            <li><button type="button" data-model="shipwreck" data-turn="90" data-open="structure=minecraft/shipwreck/with_mast" aria-pressed="false">shipwreck/with_mast</button></li>
            <li><button type="button" data-model="ancient_city" data-turn="180" data-open="structure=minecraft/ancient_city/city_center/city_center_2" aria-pressed="false">ancient_city/city_center_2</button></li>
            <li><button type="button" data-model="cherry" data-open="feature=minecraft/cherry" aria-pressed="false">feature/cherry</button></li>
            <li><button type="button" data-model="jungle" data-open="feature=minecraft/mega_jungle_tree" aria-pressed="false">feature/mega_jungle_tree</button></li>
          </ul>
          <a class="open" href="/app/?structure=minecraft/abandoned_camp/tent/bamboo_jungle/tent_bamboo_jungle_2&seed=24&level=3" data-open-link>Open it in the viewer</a>
        </div>
      </section>

      <section class="mods">
        <div class="wrap">
          <div class="mods-copy">
            <h2>Supports mods and datapacks</h2>
            <p>Add a mod or datapack, and its structures will show up alongside the vanilla ones, using its own blocks and textures. You can use this to test how your datapack structures generate without loading a world, or just to look around a pack you downloaded.</p>
            <a class="open" href="/app/">Add one in the viewer</a>
          </div>
          <div class="mod-view">
            <ul class="tree" aria-label="The viewer's structure list with Dungeons and Taverns added">
              <li class="folder">minecraft</li>
              <li class="folder expanded">
                <span>nova_structures <em>Dungeons and Taverns</em></span>
                <ul>
                  <li class="folder">badlands_miner_outpost</li>
                  <li class="folder">bunker</li>
                  <li class="folder">catacomb</li>
                  <li class="folder">cave_hut</li>
                  <li class="folder">desert_ruin</li>
                  <li class="folder expanded">
                    <span>firewatch_tower</span>
                    <ul>
                      <li>firewatch_birch</li>
                      <li>firewatch_cherry</li>
                      <li>firewatch_dark_oak</li>
                      <li class="sel">firewatch_forest</li>
                      <li>firewatch_jungle</li>
                      <li>firewatch_savanna</li>
                      <li>firewatch_taiga</li>
                    </ul>
                  </li>
                  <li class="folder">hamlet</li>
                  <li class="folder">illager_hideout</li>
                  <li class="folder">lone_citadel</li>
                </ul>
              </li>
            </ul>
            <div class="mod-shot"><img src="/home/mods/firewatch.webp" alt="The forest firewatch tower from Dungeons and Taverns" loading="lazy"></div>
          </div>
        </div>
      </section>

      <section class="generate">
        <div class="wrap">
          <div class="section-head">
            <h2>Watch a village generate</h2>
            <p>Villages are built from lots of smaller pieces, like streets, houses, and decorations. The viewer generates them the same way the game does, one level at a time. Every village has a seed, so you can share it, or re-roll for a new one.</p>
          </div>
          <ol class="steps" aria-label="Generation level" data-steps="1,2,3,4,5,6,7"></ol>
          <div class="frame wide">
            <canvas class="stage" data-stage="village" aria-label="A plains village growing from its fountain. Drag to turn it."></canvas>
          </div>
          <a class="open" href="/app/?structure=minecraft/village/plains/town_centers/plains_fountain_01">Generate a village in the viewer</a>
        </div>
      </section>

      <section class="world">
        <div class="wrap">
          <div class="section-head">
            <h2>Open your own world</h2>
            <p>Load a world save and pick the chunks you want from its map, or explore the whole world on foot while it loads in around you.</p>
          </div>
          <div class="shot"><img src="/home/world/viewer.webp" alt="The viewer with a world save open: its map in the sidebar, and a timber house and farm by a lake at sunset" width="2400" height="1662" loading="lazy"></div>
          <a class="open" href="/app/">Open a world in the viewer</a>
        </div>
      </section>

      <section class="more">
        <div class="wrap">
          <h2>Other features</h2>
          <div class="cards">
            <article class="card half">
              <div class="mock keys" aria-hidden="true"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><kbd class="space">Space</kbd></div>
              <h3>Walk around inside</h3>
              <p>Explore in first person with the game's own movement, including collision, ladders, sprinting, and flying. You can even open doors!</p>
            </article>
            <article class="card half">
              <div class="mock chips" aria-hidden="true"><code>.nbt</code><code>.litematic</code><code>.schem</code><code>.mcstructure</code></div>
              <h3>Your own builds</h3>
              <p>Open your own structure files, including Litematica, WorldEdit, and Bedrock structures.</p>
            </article>
            <article class="card">
              <div class="mock packs" aria-hidden="true"><span>my-resource-pack.zip</span><span class="base">Latest Release · 26.3</span></div>
              <h3>Resource packs</h3>
              <p>Add resource packs to change how everything looks. You can stack more than one.</p>
            </article>
            <article class="card">
              <div class="mock seed" aria-hidden="true"><code>seed 1847203</code><span>Re-roll</span></div>
              <h3>Worldgen features</h3>
              <p>Generate trees, geodes, icebergs, and every other worldgen feature from the game's own data. Re-roll to get a different one.</p>
            </article>
            <article class="card">
              <div class="mock swipe" aria-hidden="true"><span>1.21.11</span><b></b><span>26.3</span></div>
              <h3>Any version</h3>
              <p>Use the latest release, the latest snapshot, or an older version. You can also load two versions at once and swipe between them, with the changed blocks highlighted.</p>
            </article>
            <article class="card half">
              <div class="mock chips" aria-hidden="true"><code>.glb</code><code>.obj</code><code>.png</code></div>
              <h3>Export</h3>
              <p>Save a scene as a model, or render it to a PNG from any angle.</p>
            </article>
            <article class="card half">
              <div class="mock embed" aria-hidden="true"><pre>&lt;iframe
  src="structureviewer.com/app/"&gt;
&lt;/iframe&gt;</pre></div>
              <h3>Embed it</h3>
              <p>Add the viewer to your own website, and control it with its API. <a href="https://github.com/ewanhowell5195/minecraft-structure-viewer#embed-api" target="_blank" rel="noopener">Read the docs</a>.</p>
            </article>
          </div>
          <div class="end">
            <p>Everything runs in your browser. There is nothing to install or sign up for, and your files never leave your computer.</p>
            <a class="button primary big" href="/app/">Open the viewer</a>
          </div>
        </div>
      </section>
    </main>

    <footer class="footer">
      <div class="wrap">
        <nav class="footer-links" aria-label="Footer">
          <a href="/app/">Viewer</a>
          <a href="https://github.com/ewanhowell5195/minecraft-structure-viewer#embed-api" target="_blank" rel="noopener">Embed docs</a>
          <a href="https://block-model-renderer.ewanhowell.com/" target="_blank" rel="noopener">Block Model Renderer</a>
        </nav>
        <div class="footer-bottom">
          <p>© <span class="year">{{ year }}</span> <a href="https://ewanhowell.com" target="_blank" rel="noopener">Ewan Howell</a></p>
          <p>Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.</p>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup>
  import { onMounted, onUnmounted, ref } from "vue"
  import { useRouter } from "vue-router"
  import { useStylesheet } from "../stylesheet.js"
  import { mountHome } from "./home.js"
  import css from "./home.css?inline"

  useStylesheet(css)
  const router = useRouter()
  const root = ref(null)
  const year = new Date().getFullYear()
  let unmount = null

  function follow(event) {
    const link = event.target.closest("a[href]")
    if (!link || link.target || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const url = new URL(link.href)
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.hash)) return
    event.preventDefault()
    router.push(url.pathname + url.search + url.hash)
  }

  onMounted(() => {
    unmount = mountHome(root.value)
  })

  onUnmounted(() => unmount?.())
</script>
