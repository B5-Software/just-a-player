// Playback memory regression and real UI screenshots using original generated media.
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const cwd = resolve(fileURLToPath(import.meta.url), '../..'),
  root = resolve(cwd, '../..'),
  out = join(tmpdir(), 'jap-release-qa'),
  shots = join(root, 'docs/screenshots')
mkdirSync(out, { recursive: true })
mkdirSync(shots, { recursive: true })
const settings = join(tmpdir(), 'jap-e2e-userdata/settings.json'),
  library = join(tmpdir(), 'jap-e2e-userdata/playlists.json')
mkdirSync(dirname(settings), { recursive: true })
const original = existsSync(settings) ? readFileSync(settings, 'utf8') : '{}',
  originalLibrary = existsSync(library) ? readFileSync(library, 'utf8') : null
writeFileSync(
  settings,
  JSON.stringify({
    ...JSON.parse(original),
    onboardingComplete: true,
    disabledVisuals: [],
    legacyVisuals: false,
    visualPlugins: [],
    autoHideControls: false,
    wallpaperEnabled: false,
    argbEnabled: false,
    autoScan: false,
    rememberPlaylist: true,
    themeMode: 'dark',
    lyricsSize: 68,
    lyricsFont: 'zhi-mang-xing',
    lyricsMode: '3d',
    lyricsVisible: true,
    lyricsPose: 'none',
    lyricsPosition: 'right',
    lyricsOffset: { x: 0, y: -45, z: 0 },
    renderGpu: 'auto',
    hdrEnabled: false,
    renderFps: 30,
    autoAccent: true,
    autoBackdrop: true,
    backdropBrightness: 0.25,
  })
)
const rate = 48000,
  length = 40,
  pcm = Buffer.alloc(rate * length * 6),
  header = Buffer.alloc(44)
for (let i = 0; i < rate * length; i++) {
  const t = i / rate,
    beat = t % 0.5,
    kick = Math.sin(2 * Math.PI * (45 + 60 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 12)
  for (let c = 0; c < 2; c++) {
    const chord = [110, 164.8138, 220, 277.1826, 329.6276].reduce(
      (n, f, k) => n + Math.sin(2 * Math.PI * f * t + c * 0.1 * k) * 0.018,
      0
    )
    const v = Math.max(
      -1,
      Math.min(
        1,
        chord + kick * 0.12 + Math.sin(2 * Math.PI * (660 + 80 * Math.sin(t)) * t) * 0.014
      )
    )
    pcm.writeIntLE(Math.round(v * 8388607), i * 6 + c * 3, 3)
  }
}
header.write('RIFF')
header.writeUInt32LE(36 + pcm.length, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(2, 22)
header.writeUInt32LE(rate, 24)
header.writeUInt32LE(rate * 6, 28)
header.writeUInt16LE(6, 32)
header.writeUInt16LE(24, 34)
header.write('data', 36)
header.writeUInt32LE(pcm.length, 40)
const raw = join(out, 'source.wav'),
  track = join(out, '星河漫游.flac')
writeFileSync(raw, Buffer.concat([header, pcm]))
execFileSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-y',
    '-i',
    raw,
    '-c:a',
    'flac',
    '-metadata',
    'title=星河漫游',
    '-metadata',
    'artist=B5-Software',
    '-metadata',
    'album=Just A Player · 原创演示',
    track,
  ],
  { windowsHide: true }
)
const checks = {},
  errors = []
let app, page
const assert = (v, m) => {
  if (!v) throw new Error(m)
}
async function launch() {
  app = await electron.launch({
    executablePath: electronPath,
    cwd,
    args: ['.'],
    env: { ...process.env, JAP_E2E: 'release' },
  })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(
    () => window.__jap?.usePlayer.getState().connected && window.__jap.useLibrary.getState().loaded
  )
  await page.evaluate(() =>
    window.__jap.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
  )
}
try {
  await launch()
  const cover = await page.evaluate(async () => {
    await document.fonts.ready
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 768
    const c = canvas.getContext('2d')
    const g = c.createLinearGradient(0, 0, 768, 768)
    g.addColorStop(0, '#102652')
    g.addColorStop(0.5, '#6856b2')
    g.addColorStop(1, '#e29cbb')
    c.fillStyle = g
    c.fillRect(0, 0, 768, 768)
    for (let i = 0; i < 120; i++) {
      const x = (i * 193 + 41) % 768,
        y = (i * 367 + 73) % 768
      c.fillStyle = `rgba(255,255,255,${0.2 + (i % 5) / 8})`
      c.beginPath()
      c.arc(x, y, i % 7 === 0 ? 2.4 : 1, 0, Math.PI * 2)
      c.fill()
    }
    c.strokeStyle = '#ffffff48'
    c.lineWidth = 1.5
    for (let i = 0; i < 4; i++) {
      c.beginPath()
      c.ellipse(420, 390, 330 + i * 26, 100 + i * 9, -0.48, 0, Math.PI * 2)
      c.stroke()
    }
    const orb = c.createRadialGradient(350, 255, 0, 385, 330, 160)
    orb.addColorStop(0, '#fff3ea')
    orb.addColorStop(0.5, '#d8c3f5')
    orb.addColorStop(1, '#727edb')
    c.fillStyle = orb
    c.beginPath()
    c.arc(385, 330, 160, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = '#fff'
    c.font = 'bold 68px "Noto Sans SC"'
    c.fillText('星河漫游', 70, 625)
    c.font = '22px "Noto Sans SC"'
    c.fillStyle = '#ffffffae'
    c.fillText('JUST A PLAYER  /  ORIGINAL DEMO', 74, 680)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  writeFileSync(join(out, 'cover.png'), Buffer.from(cover, 'base64'))
  checks.ids = await page.evaluate((path) => {
    const j = window.__jap,
      l = j.useLibrary.getState(),
      id = l.createList('星际电台')
    const [item] = j.useLibrary.getState().addPaths(id, [path])
    j.useViz.getState().setAuto(false)
    j.useViz.getState().setScene('silk-studio')
    return { id, item }
  }, track)
  await page.waitForFunction(() => window.__jap.useCover.getState().art?.url)
  assert(
    (await page.locator('[data-player-dock] h1').innerText()) === '星际电台',
    'Idle dock shows count instead of list name'
  )
  assert((await page.locator('[data-player-dock] img').count()) > 0, 'Pending item cover missing')
  await page.locator('[data-player-dock]').screenshot({ path: join(shots, 'playlist.png') })
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'playing')
  await page.evaluate(() => window.__jap.usePlayer.getState().seek(13000))
  await page.waitForTimeout(250)
  await page.evaluate(() => window.__jap.usePlayer.getState().togglePause())
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'paused')
  await page.waitForTimeout(650)
  checks.remembered = JSON.parse(await page.evaluate(() => window.jap.libraryLoad())).memories[
    checks.ids.id
  ]
  assert(checks.remembered.positionMs >= 12500, 'Playback position not saved')
  await app.close()
  app = null
  await launch()
  assert(
    await page.evaluate(
      () =>
        window.__jap.usePlayer.getState().state === 'stopped' &&
        !window.__jap.usePlayer.getState().track
    ),
    'Restart autoplays or loads stale track'
  )
  await page.waitForFunction(() => window.__jap.useCover.getState().art?.url)
  assert(
    (await page.locator('[data-player-dock] h1').innerText()) === '星际电台',
    'List name lost on restart'
  )
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.waitForFunction(
    () =>
      window.__jap.usePlayer.getState().state === 'playing' &&
      window.__jap.usePlayer.getState().position.ms >= 12500
  )
  checks.resumedPosition = await page.evaluate(() => window.__jap.usePlayer.getState().position.ms)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)
  )
  await page.evaluate(() => {
    const j = window.__jap
    j.useSettings.getState().update({ vizCustomOffset: true, vizOffset: { x: -320, y: 0, z: 0 } })
    j.useViz.setState({ offset: { x: -320, y: 0, z: 0 }, userCustomOffset: true, zoom: 1 })
    j.useLyrics.setState({
      text: '[00:00.00]让声音长出形状\n[00:08.00]让旋律点亮星河\n[00:16.00]在音乐里 遇见另一片宇宙\n[00:24.00]把此刻交给耳朵与眼睛\n[00:32.00]Just A Player · B5-Software',
    })
    j.usePlayer.getState().seek(18000)
  })
  await page.waitForTimeout(1600)
  await page.mouse.move(1200, 750)
  await page.screenshot({ path: join(shots, 'hero.png') })
  await page.evaluate(() => {
    window.__jap.useSettings.getState().update({ lyricsVisible: false, legacyVisuals: true })
  })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === '时频谱')
  )
  await page.evaluate(() => window.__jap.useViz.getState().setScene('spectrogram'))
  await page.waitForTimeout(3200)
  await page.screenshot({ path: join(shots, 'instruments.png') })
  await page.evaluate(() => window.jap.setWindowMode('mini'))
  await page.locator('[data-mini-player]').waitFor()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(shots, 'mini.png') })
  checks.screenshots = ['hero', 'instruments', 'mini', 'playlist']
  assert(errors.length === 0, errors.join('\n'))
  console.log(JSON.stringify({ ok: true, checks, shots }, null, 2))
} catch (e) {
  errors.push(String(e))
  process.exitCode = 1
  console.error(e)
} finally {
  if (app) await app.close()
  writeFileSync(settings, original)
  if (originalLibrary !== null) writeFileSync(library, originalLibrary)
  writeFileSync(join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
}
