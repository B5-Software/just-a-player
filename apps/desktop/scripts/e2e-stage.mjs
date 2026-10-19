// Interaction and compositor regression: no real audio device or user library.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { desktopLayout } from '../src/shared/desktop-layout.ts'

const cwd = resolve(fileURLToPath(import.meta.url), '../..'),
  out = join(tmpdir(), 'jap-stage-qa')
const settings = join(tmpdir(), 'jap-e2e-userdata', 'settings.json')
mkdirSync(out, { recursive: true })
mkdirSync(dirname(settings), { recursive: true })
const original = existsSync(settings) ? readFileSync(settings, 'utf8') : '{}'
writeFileSync(
  settings,
  JSON.stringify({
    ...JSON.parse(original),
    wallpaperEnabled: false,
    argbEnabled: false,
    hdrEnabled: false,
    renderGpu: 'auto',
    autoScan: false
  })
)
const checks = {},
  errors = []
const assert = (v, message) => {
  if (!v) throw new Error(message)
}
let app
try {
  const layout = desktopLayout([
    { id: 1, x: 0, y: 0, width: 2560, height: 1440 },
    { id: 2, x: -1920, y: 240, width: 1920, height: 1080 },
    { id: 3, x: 2560, y: -800, width: 2160, height: 3840 }
  ])
  assert(
    layout.width === 6640 &&
      layout.height === 3840 &&
      layout.displays[0].x === 1920 &&
      layout.displays[1].y === 1040,
    'Physical desktop union failed'
  )
  checks.negativePortraitLayout = layout
  app = await electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd,
    env: { ...process.env, JAP_E2E: 'stage' }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected && window.__japViz)
  await page.evaluate(() => {
    const j = window.__jap
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
    j.useLyrics.setState({ text: null })
    j.useSettings
      .getState()
      .update({
        lyricsMode: '3d',
        lyricsVisible: true,
        lyricsPosition: 'right',
        lyricsOffset: { x: 0, y: -30, z: 0 },
        lyricsPose: 'none',
        renderFps: 30,
        autoBackdrop: false
      })
    j.useViz.getState().setAuto(false)
    j.useViz.getState().setScene('orb')
    j.useUi.getState().setOnboardingOpen(true)
  })
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.waitForFunction(() => window.__japLyrics?.ready && window.__japLyrics.lines[2]?.o)
  await page.waitForTimeout(1100)
  await page.screenshot({ path: join(out, 'onboarding-test-lyrics.png') })
  assert(
    await page.evaluate(
      () => window.__jap.useLyrics.getState().text === null && window.__japLyrics.preview
    ),
    'Demo overwrote real lyrics or was not shown'
  )
  const hit = () =>
    page.evaluate(() => {
      const r = window.__japLyrics,
        mesh = r.lines[2].o.grp.children[1],
        attr = mesh.geometry.attributes.position
      for (let i = 0; i + 2 < attr.count; i += 15) {
        const p = mesh.position.clone().set(0, 0, 0)
        for (let n = 0; n < 3; n++) {
          p.x += attr.getX(i + n) / 3
          p.y += attr.getY(i + n) / 3
          p.z += attr.getZ(i + n) / 3
        }
        mesh.localToWorld(p)
        p.project(r.camera)
        const x = ((p.x + 1) * innerWidth) / 2,
          y = ((1 - p.y) * innerHeight) / 2
        if (x < 400 || x > innerWidth - 50 || y < 210 || y > innerHeight - 210) continue
        r.raycaster.setFromCamera(p, r.camera)
        if (r.raycaster.intersectObject(r.root, true).length) return { x, y }
      }
      throw new Error('No visible demo lyric hit target')
    })
  let p = await hit()
  const origin = await page.evaluate(() => {
    const r = window.__japLyrics
    return { x: r.cur.ox / r.halfW, y: r.cur.oy / r.halfH, w: r.width, h: r.height }
  })
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  assert(await page.evaluate(() => window.__japLyrics.dragging), 'Text press did not begin drag')
  await page.mouse.move(p.x + 70, p.y + 40, { steps: 5 })
  await page.mouse.up()
  const offset = await page.evaluate(() => window.__jap.useSettings.getState().lyricsOffset)
  assert(
    Math.abs(offset.x - origin.x - 140 / origin.w) < 0.025 &&
      Math.abs(offset.y - origin.y + 80 / origin.h) < 0.025,
    'Drag jumped to cursor instead of preserving grab offset'
  )
  await page.mouse.move(700, 600)
  assert(
    await page.evaluate(() => !window.__japLyrics.dragging),
    'Lyrics follow hover after release'
  )
  await page.mouse.move(600, 130)
  await page.mouse.down()
  await page.mouse.move(650, 170)
  await page.mouse.up()
  assert(await page.evaluate(() => !window.__japLyrics.dragging), 'Empty stage began lyric drag')
  for (const reason of ['buttons', 'blur', 'cancel', 'capture']) {
    await page.waitForTimeout(300)
    p = await hit()
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x - 20, p.y - 10)
    assert(await page.evaluate(() => window.__japLyrics.dragging), 'Could not begin ' + reason)
    await page.evaluate((reason) => {
      const r = window.__japLyrics,
        id = r.dragPointer
      if (reason === 'blur') window.dispatchEvent(new Event('blur'))
      else if (reason === 'capture') r.canvas.releasePointerCapture(id)
      else
        r.canvas.dispatchEvent(
          new PointerEvent(reason === 'buttons' ? 'pointermove' : 'pointercancel', {
            pointerId: id,
            pointerType: 'mouse',
            buttons: 0,
            bubbles: true
          })
        )
    }, reason)
    await page.mouse.up()
    await page.waitForTimeout(50)
    assert(await page.evaluate(() => !window.__japLyrics.dragging), 'Stuck drag after ' + reason)
  }
  checks.demoAndDrag = [
    'release',
    'blank',
    'missed-up',
    'blur',
    'cancel',
    'capture-loss',
    'grab-offset'
  ]
  await page.getByRole('button', { name: '跳过指导' }).click()
  await page.waitForFunction(
    () => !window.__japLyrics.preview && window.__japLyrics.lines.length === 0
  )
  checks.demoRestored = await page.evaluate(() => window.__jap.useLyrics.getState().text === null)
  await page.evaluate(() => {
    const j = window.__jap
    j.useLyrics.setState({ text: '[00:00.00]测试真正的二维拖动\n[00:05.00]松手就停止' })
    j.useSettings
      .getState()
      .update({ lyricsMode: '2d', lyricsPosition: 'center', lyricsOffset: { x: 0, y: 0, z: 0 } })
    j.useUi.getState().setLyricsAdjusting(true)
  })
  const two = page.getByText('按住歌词拖动 · 松开放下').locator('..')
  const box = await two.boundingBox()
  await page.mouse.move(box.x + 120, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(box.x + 190, box.y + 140, { steps: 4 })
  await page.mouse.up()
  const twoOffset = await page.evaluate(() => window.__jap.useSettings.getState().lyricsOffset)
  await page.mouse.move(400, 250)
  assert(
    JSON.stringify(twoOffset) ===
      (await page.evaluate(() => JSON.stringify(window.__jap.useSettings.getState().lyricsOffset))),
    '2D lyrics follow hover'
  )
  assert(Math.abs(twoOffset.x) > 0.02, '2D drag did not commit')
  await page.evaluate(() => {
    window.__jap.useUi.getState().setLyricsAdjusting(false)
    window.__jap.useSettings.getState().update({ lyricsMode: '3d' })
    window.__jap.useLyrics.setState({ text: null })
  })
  checks.twoDimensionalDrag = true

  // Sample Chromium's composed window, including resized presentation layers.
  const composed = async (surface) =>
    app.evaluate(async ({ BrowserWindow }, surface) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        surface === 'main'
          ? !w.webContents.getURL().includes('surface=')
          : w.webContents.getURL().includes('surface=' + surface)
      )
      const image = await w.webContents.capturePage()
      const size = image.getSize(),
        pixels = image
          .crop({
            x: Math.floor(size.width * 0.25),
            y: Math.floor(size.height * 0.25),
            width: Math.floor(size.width * 0.5),
            height: Math.floor(size.height * 0.4)
          })
          .resize({ width: 32, height: 18 })
          .toBitmap()
      let peak = 0,
        lit = 0
      for (let i = 0; i < pixels.length; i += 4) {
        const m = Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
        peak = Math.max(peak, m)
        if (m > 12) lit++
      }
      return { peak, lit }
    }, surface)
  checks.compositor = []
  for (let i = 0; i < 48; i++) {
    if (i % 3 === 0)
      await app.evaluate(({ BrowserWindow }, i) => {
        const w = BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().includes('surface=')
        )
        w.setSize(1000 + (i % 5) * 80, 680 + (i % 4) * 60)
      }, i)
    if (i % 6 === 0)
      await page.evaluate(
        (i) => window.__jap.useViz.getState().setScene(['orb', 'plasma'][(i / 6) % 2]),
        i
      )
    const sample = await composed('main')
    checks.compositor.push(sample)
    assert(sample.peak > 12, 'Compositor presented black during resize/scene switch: ' + i)
  }
  await page.evaluate(() => {
    window.__loss = window.__japViz.renderer.getContext().getExtension('WEBGL_lose_context')
    window.__loss.loseContext()
  })
  await page.waitForTimeout(150)
  assert((await composed('main')).peak > 12, 'Compositor black during context loss')
  await page.evaluate(() => window.__loss.restoreContext())
  await page.waitForFunction(() => !window.__japViz.contextLost)
  checks.compositorContext = true

  const created = app.waitForEvent('window')
  await page.evaluate(() =>
    window.__jap.useSettings.getState().update({ wallpaperEnabled: true, wallpaperTime: true })
  )
  const wall = await created
  wall.on('pageerror', (e) => errors.push(e.message))
  await wall.waitForFunction(
    () =>
      window.__japViz?.frameVersion > 0 && document.documentElement.dataset.renderSuspended === '1'
  )
  checks.connectedDisplays = await app.evaluate(({ screen }) =>
    screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor }))
  )
  assert(
    (await wall.locator('[data-wallpaper-display]').count()) === checks.connectedDisplays.length,
    'Not all monitors covered'
  )
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.jap.setWindowMode('mini'))
    await wall.waitForFunction(() => document.documentElement.dataset.renderSuspended !== '1')
    assert((await composed('wallpaper')).peak > 12, 'Black live wallpaper')
    await page.evaluate(() => window.jap.setWindowMode('normal'))
    await wall.waitForFunction(() => document.documentElement.dataset.renderSuspended === '1')
    assert((await composed('wallpaper')).peak > 12, 'Black static wallpaper')
  }
  // Three-screen layout through the real presentation IPC, including hot removal.
  await app.evaluate(({ BrowserWindow }, layout) => {
    const w = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('surface=wallpaper')
    )
    w.webContents.send('wallpaper:state', { live: true, snapshot: null, token: 9000, layout })
  }, layout)
  await wall.waitForFunction(
    () => document.querySelectorAll('[data-wallpaper-display]').length === 3
  )
  await wall.waitForTimeout(1000)
  checks.mirrorRegions = await wall
    .locator('[data-wallpaper-display]')
    .evaluateAll((els) =>
      els.map((el) => ({
        id: el.dataset.wallpaperDisplay,
        width: el.clientWidth,
        height: el.clientHeight,
        filled: [...el.querySelectorAll('canvas')].some(
          (c) => c.width > 300 && getComputedStyle(c).visibility === 'visible'
        )
      }))
    )
  assert(
    checks.mirrorRegions.every((d) => d.filled && d.width > 0 && d.height > 0),
    'Empty multi-display output'
  )
  assert(
    (await wall.locator('[data-wallpaper-source]').count()) === 1,
    'Multiple scene renderers created'
  )
  await page.screenshot({ path: join(out, 'main.png') })
  await wall.screenshot({ path: join(out, 'three-monitor-preview.png') })
  await app.evaluate(({ screen }) =>
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), [
      'bounds',
      'scaleFactor'
    ])
  )
  await wall.waitForFunction(
    (n) => document.querySelectorAll('[data-wallpaper-display]').length === n,
    checks.connectedDisplays.length
  )
  checks.wallpaperTransitions = 8
  await page.evaluate(() => window.__jap.useSettings.getState().update({ wallpaperEnabled: false }))
  assert(errors.length === 0, errors.join('\n'))
  console.log(JSON.stringify({ ok: true, checks, out }, null, 2))
} catch (e) {
  errors.push(String(e))
  process.exitCode = 1
  console.error(e)
} finally {
  if (app) await app.close()
  writeFileSync(settings, original)
  writeFileSync(join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
}
