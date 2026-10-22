import { answerNextFileDialog } from './e2e-dialog-helper.mjs'
// Fonts, artwork, native SMTC, independent wallpaper and OpenRGB protocol regression.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
const appDir = resolve(fileURLToPath(import.meta.url), '../..'),
  out = join(tmpdir(), 'jap-polish-qa'),
  album = join(out, 'album')
mkdirSync(album, { recursive: true })
const flac = join(album, 'first.flac'),
  second = join(album, 'second.flac')
for (const [path, title] of [
  [flac, '星河 · 系统媒体回归'],
  [second, '云间来信'],
])
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=90:sample_rate=48000',
      '-ac',
      '2',
      '-metadata',
      `title=${title}`,
      '-metadata',
      'artist=Just A Player Studio',
      '-metadata',
      'album=夜航 / A Little Light',
      '-c:a',
      'flac',
      path,
    ],
    { windowsHide: true }
  )
writeFileSync(
  join(album, 'first.lrc'),
  '[00:00.00]星河落在你的眼里\n[00:02.00]听见夜色的回声\n[00:04.00]我们一起慢慢走'
)
const u16 = (n) => {
    const b = Buffer.alloc(2)
    b.writeUInt16LE(n)
    return b
  },
  u32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  },
  str = (v) => {
    const b = Buffer.from(v + '\0')
    return Buffer.concat([u16(b.length), b])
  }
const mode = (name, value) =>
  Buffer.concat([
    str(name),
    ...[value, 3, 0, 100, 0, 100, 1, 1, 50, 100, 0, 1].map(u32),
    u16(1),
    Buffer.from([17, 34, 51, 0]),
  ])
const original = Buffer.from([17, 34, 51, 0, 17, 34, 51, 0, 17, 34, 51, 0, 17, 34, 51, 0])
const block = Buffer.concat([
  u32(0),
  u32(1),
  str('QA ARGB Controller'),
  str('Just A Player'),
  str('SDK fixture'),
  str('1'),
  str('QA-001'),
  str('local'),
  u16(2),
  u32(1),
  mode('Direct', 0),
  mode('Breathing', 1),
  u16(1),
  str('ARGB header'),
  u32(2),
  u32(1),
  u32(4),
  u32(4),
  u16(0),
  u16(4),
  ...Array.from({ length: 4 }, (_, i) => Buffer.concat([str(`LED ${i}`), u32(i)])),
  u16(4),
  original,
])
block.writeUInt32LE(block.length)
const packets = [],
  sockets = new Set()
const server = createServer((socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  let buffer = Buffer.alloc(0)
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data])
    while (buffer.length >= 16) {
      const length = buffer.readUInt32LE(12)
      if (buffer.length < 16 + length) break
      const id = buffer.readUInt32LE(4),
        type = buffer.readUInt32LE(8),
        payload = Buffer.from(buffer.subarray(16, 16 + length))
      buffer = buffer.subarray(16 + length)
      packets.push({ type, id, payload })
      const reply = type === 40 ? u32(6) : type === 0 ? u32(1) : type === 1 ? block : null
      if (reply) {
        const h = Buffer.concat([Buffer.from('ORGB'), u32(id), u32(type), u32(reply.length)])
        socket.write(h.subarray(0, 7))
        setImmediate(() => socket.write(Buffer.concat([h.subarray(7), reply])))
      }
    }
  })
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  cwd: appDir,
  env: { ...process.env, JAP_E2E: 'polish' },
})
const page = await app.firstWindow(),
  checks = {},
  errors = [],
  logs = []
page.setDefaultTimeout(60000)
page.on('pageerror', (e) => errors.push(e.message))
app.process().stderr?.on('data', (b) => logs.push(b.toString()))
const assert = (v, m) => {
  if (!v) throw new Error(m)
}
const wait = async (fn, ms = 10000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('Condition timeout')
    await new Promise((ok) => setTimeout(ok, 50))
  }
}
try {
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  await page.evaluate((port) => {
    const j = window.__jap
    j.useSettings.getState().update({
      autoScan: false,
      wallpaperEnabled: false,
      argbEnabled: true,
      argbPort: port,
      argbDevices: ['*'],
      argbBrightness: 0.5,
      autoAccent: false,
      accent: '#ff3366',
      renderFps: 30,
      lyricsVisible: true,
      lyricsMode: '2d',
      lyricsSize: 100,
      lyricsFont: 'ma-shan-zheng',
      fullscreenTime: true,
      fullscreenDate: true,
    })
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
    j.useViz.getState().setAuto(false)
    j.useViz.getState().setScene('orb')
  }, server.address().port)
  await wait(() =>
    packets.some(
      (p) => p.type === 1050 && p.payload.subarray(6, 9).equals(Buffer.from([128, 26, 51]))
    )
  )
  checks.argb = await page.evaluate(() => window.jap.lightingStatus())
  assert(checks.argb.connected && checks.argb.devices[0].leds === 4, 'OpenRGB discovery failed')
  await page.evaluate(() => window.__jap.useSettings.getState().update({ argbEnabled: false }))
  await wait(() => packets.some((p) => p.type === 1101 && p.payload.readUInt32LE(4) === 1))
  assert(
    packets
      .filter((p) => p.type === 1050)
      .at(-1)
      .payload.subarray(6)
      .equals(original),
    'ARGB did not restore original colors'
  )
  const gradient = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 512
    const x = c.getContext('2d'),
      g = x.createLinearGradient(0, 0, 512, 512)
    g.addColorStop(0, '#f5b2a1')
    g.addColorStop(0.45, '#b45e9f')
    g.addColorStop(1, '#203e88')
    x.fillStyle = g
    x.fillRect(0, 0, 512, 512)
    x.fillStyle = '#ffffffc0'
    x.font = '700 64px "Noto Serif SC"'
    x.fillText('夜航', 78, 225)
    return c.toDataURL().split(',')[1]
  })
  writeFileSync(join(album, 'cover.png'), Buffer.from(gradient, 'base64'))
  await page.evaluate(
    async (paths) => {
      const j = window.__jap
      j.useLibrary.getState().createList('系统媒体回归')
      await j.addAudioPaths(paths, false)
      const s = j.useLibrary.getState(),
        list = s.lists.find((l) => l.id === s.activeListId)
      j.playItem(list.id, list.items.find((i) => i.path.endsWith('first.flac')).id)
    },
    [flac, second]
  )
  await page.waitForFunction(
    () =>
      window.__jap.usePlayer.getState().state === 'playing' &&
      window.__jap.useCover.getState().art &&
      window.__jap.useLyrics.getState().text
  )
  await page.getByRole('button', { name: '歌词', exact: true }).click()
  assert(
    (await page.getByRole('button', { name: '马善政楷书', exact: true }).count()) === 1,
    'Font label missing'
  )
  checks.fontLabel = await page
    .getByRole('button', { name: '马善政楷书', exact: true })
    .locator('span')
    .evaluate((el) => ({
      whiteSpace: getComputedStyle(el).whiteSpace,
      height: el.getBoundingClientRect().height,
    }))
  assert(checks.fontLabel.whiteSpace === 'nowrap', 'Font name can wrap')
  assert(
    (await page.getByRole('button', { name: '龙藏手书', exact: true }).count()) === 1,
    'New OFL fonts missing'
  )
  const ttf = join(out, 'LongCang.ttf'),
    otf = join(out, 'SourceCodePro.otf')
  for (const [path, url] of [
    [ttf, 'https://raw.githubusercontent.com/google/fonts/main/ofl/longcang/LongCang-Regular.ttf'],
    [
      otf,
      'https://raw.githubusercontent.com/adobe-fonts/source-code-pro/release/OTF/SourceCodePro-Regular.otf',
    ],
  ]) {
    if (existsSync(path)) continue
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Official font fixture download failed: ${response.status}`)
    writeFileSync(path, Buffer.from(await response.arrayBuffer()))
  }
  const raw = readFileSync(ttf),
    ttc = Buffer.alloc(16 + raw.length)
  ttc.write('ttcf')
  ttc.writeUInt32BE(0x10000, 4)
  ttc.writeUInt32BE(1, 8)
  ttc.writeUInt32BE(16, 12)
  raw.copy(ttc, 16)
  for (let i = 0; i < raw.readUInt16BE(4); i++) {
    const at = 16 + 12 + i * 16 + 8
    ttc.writeUInt32BE(ttc.readUInt32BE(at) + 16, at)
  }
  const collection = join(out, 'LongCang.ttc')
  writeFileSync(collection, ttc)
  const woff = join(
      appDir,
      'node_modules/@fontsource/ma-shan-zheng/files/ma-shan-zheng-latin-400-normal.woff'
    ),
    woff2 = join(appDir, 'src/renderer/src/fonts/zcool-kuaile-chinese-simplified-400-normal.woff2')
  await answerNextFileDialog(page, [ttf, otf, woff, woff2, collection])
  await page.getByRole('button', { name: '导入字体…', exact: true }).click()
  await page.waitForFunction(() => window.__jap.useFontCatalog.getState().imported.length >= 4)
  await page.waitForFunction(() => document.body.textContent.includes('已导入 5 款字体'))
  checks.importedFonts = await page.evaluate(() =>
    window.__jap.useFontCatalog.getState().imported.map((f) => ({
      label: f.label,
      loaded: document.fonts.check(`400 24px "${f.family}"`),
    }))
  )
  assert(
    checks.importedFonts.every((f) => f.loaded),
    'Imported font did not load'
  )
  await page.evaluate(() => window.__jap.useSettings.getState().update({ lyricsSize: 150 }))
  await page.screenshot({ path: join(out, 'font-panel.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '悬浮播放', exact: true }).click()
  await page.locator('[data-mini-player]').waitFor()
  assert(
    await page
      .locator('[data-mini-player]')
      .getByText('Just A Player', { exact: true })
      .isVisible(),
    'Mini player has wrong application name'
  )
  assert(await page.locator('[data-mini-backdrop]').isVisible(), 'Mini cover blur missing')
  await page.screenshot({ path: join(out, 'mini-cover.png') })
  await page.getByRole('button', { name: '展开播放器' }).click()
  const wallCreated = app.waitForEvent('window')
  await page.evaluate(() =>
    window.__jap.useSettings
      .getState()
      .update({ wallpaperEnabled: true, wallpaperTime: true, wallpaperDate: true })
  )
  const wall = await wallCreated
  await wall.waitForFunction(
    () =>
      window.__japViz?.frameVersion > 0 && document.documentElement.dataset.renderSuspended === '1'
  )
  const pausedAt = await wall.evaluate(() => window.__japViz.lastDraw)
  await page.waitForTimeout(300)
  assert(
    (await wall.evaluate(() => window.__japViz.lastDraw)) === pausedAt,
    'Wallpaper renders while main interface is shown'
  )
  await page.getByRole('button', { name: '悬浮播放', exact: true }).click()
  await page.locator('[data-mini-player]').waitFor()
  await wall.waitForFunction(() => document.documentElement.dataset.renderSuspended !== '1')
  const mainAt = await page.evaluate(() => window.__japViz.lastDraw),
    wallAt = await wall.evaluate(() => window.__japViz.lastDraw)
  await page.waitForTimeout(300)
  assert(
    (await page.evaluate(() => window.__japViz.lastDraw)) === mainAt,
    'Mini draws a duplicate stage'
  )
  assert(
    (await wall.evaluate(() => window.__japViz.lastDraw)) > wallAt,
    'Mini pauses live desktop wallpaper'
  )
  await app.evaluate(({ screen }) => {
    global.__qaOldCursor = screen.getCursorScreenPoint
    const b = screen.getPrimaryDisplay().bounds
    screen.getCursorScreenPoint = () => ({ x: b.x + b.width * 0.8, y: b.y + b.height * 0.25 })
  })
  await wall.waitForFunction(
    () =>
      Math.abs(window.__japViz.pointerTarget.x - 0.6) < 0.01 &&
      Math.abs(window.__japViz.pointerTarget.y - 0.5) < 0.01
  )
  checks.wallpaperMouse = true
  assert(await wall.locator('[data-clock-overlay]').isVisible(), 'Wallpaper clock missing')
  await wall.screenshot({ path: join(out, 'wallpaper-live.png') })
  await app.evaluate(({ screen }) => {
    screen.getCursorScreenPoint = global.__qaOldCursor
  })
  await page.getByRole('button', { name: '展开播放器' }).click()
  await wall.locator('[data-wallpaper-snapshot]').waitFor()
  await wall.waitForFunction(() => document.documentElement.dataset.renderSuspended === '1')
  const stillAt = await wall.evaluate(() => window.__japViz.lastDraw)
  await page.waitForTimeout(250)
  assert(
    (await wall.evaluate(() => window.__japViz.lastDraw)) === stillAt,
    'Wallpaper did not stop after expanding main interface'
  )
  await wall.screenshot({ path: join(out, 'wallpaper-static.png') })
  checks.singleActiveRender = true
  await page.evaluate(() => window.__jap.useViz.getState().setFullscreen(true))
  await page.locator('[data-clock-overlay]').waitFor()
  await page.evaluate(() => window.__jap.useViz.getState().setFullscreen(false))
  const closedWall = wall.waitForEvent('close')
  await page.evaluate(() => window.__jap.useSettings.getState().update({ wallpaperEnabled: false }))
  await closedWall
  // The native session can be inspected and operated by Windows, independently
  // of the renderer bridge or a browser MediaSession.
  const smtc = join(out, 'smtc.ps1')
  writeFileSync(
    smtc,
    `param([string]$Action='read')
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
function Await($op,$type) { $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 } | Select-Object -First 1; $task=$method.MakeGenericMethod($type).Invoke($null,@($op)); $null=$task.Wait(5000); $task.Result }
$manager=Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session=$manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -eq 'B5Software.JustAPlayer' } | Select-Object -First 1
if (!$session) { throw 'Just A Player native SMTC session not visible to Windows' }
if ($Action -eq 'pause') { $null=Await ($session.TryPauseAsync()) ([bool]) }
if ($Action -eq 'play') { $null=Await ($session.TryPlayAsync()) ([bool]) }
if ($Action -eq 'next') { $null=Await ($session.TrySkipNextAsync()) ([bool]) }
$props=Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
@{ title=$props.Title; artist=$props.Artist; album=$props.AlbumTitle; source=$session.SourceAppUserModelId; state=$session.GetPlaybackInfo().PlaybackStatus.ToString(); thumbnail=($null -ne $props.Thumbnail) } | ConvertTo-Json -Compress
`
  )
  const system = (action) =>
    JSON.parse(
      execFileSync('powershell.exe', ['-NoProfile', '-File', smtc, '-Action', action], {
        windowsHide: true,
        encoding: 'utf8',
      }).trim()
    )
  checks.smtc = system('read')
  assert(
    checks.smtc.title === '星河 · 系统媒体回归' &&
      checks.smtc.album === '夜航 / A Little Light' &&
      checks.smtc.artist === 'Just A Player Studio' &&
      checks.smtc.thumbnail,
    'Windows metadata/artwork missing'
  )
  system('pause')
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'paused')
  system('play')
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'playing')
  system('next')
  await page.waitForFunction(() =>
    window.__jap.usePlayer.getState().track?.path.endsWith('second.flac')
  )
  checks.systemControls = true
  // Trigger the real Tray right-click listener, then operate our own menu UI.
  // Exposed only in E2E by the main process, with no production IPC surface.
  await page.evaluate(() => window.__jap.useSettings.getState().update({ autoAccent: true }))
  const autoColor = await page.evaluate(() => {
    const hex = window.__jap.useCover.getState().palette.primary
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ')
  })
  const trayCreated = app.waitForEvent('window')
  await app.evaluate(() => global.__japOpenTrayMenu?.())
  const trayPage = await trayCreated
  await trayPage.waitForFunction(
    (rgb) => document.documentElement.style.getPropertyValue('--accent').trim() === rgb,
    autoColor
  )
  checks.trayAutoAccent = true
  await trayPage.locator('[data-tray-menu] img').last().waitFor()
  assert(
    (await trayPage.getByText('云间来信', { exact: true }).count()) === 1,
    'Tray metadata missing'
  )
  assert(
    (await trayPage
      .locator('[data-tray-menu]')
      .evaluate((el) => getComputedStyle(el).boxShadow)) === 'none',
    'Tray shadow remains'
  )
  await trayPage.screenshot({ path: join(out, 'tray-menu.png') })
  await trayPage.getByRole('button', { name: '暂停', exact: true }).click()
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'paused')
  await trayPage.keyboard.press('Escape')
  checks.customTray = true
  await page.evaluate(() => window.__jap.useSettings.getState().update({ autoAccent: false }))
  await page.evaluate((path) => window.__jap.usePlayer.getState().play(path), flac)
  await page.waitForFunction(() => window.__jap.useCover.getState().art)
  checks.fade = await page.evaluate(() =>
    [0, 1, 2 - 1 / 24].map((t) => window.__jap.metadataOpacity(t, 2, 24))
  )
  assert(
    checks.fade[0] === 0 && checks.fade[1] === 1 && checks.fade[2] === 0,
    'Metadata fade endpoints incorrect'
  )
  for (const [w, h] of [
    [960, 540],
    [720, 720],
    [540, 960],
  ]) {
    const encoded = await page.evaluate(
      async ([w, h]) => {
        const j = window.__jap
        return (
          await j.createCoverCard(
            j.usePlayer.getState().track,
            j.useCover.getState().art.url,
            '#c37aac',
            w,
            h,
            'noto-serif',
            'B5 · 夜航'
          )
        )
          .toDataURL()
          .split(',')[1]
      },
      [w, h]
    )
    writeFileSync(join(out, `cover-${w}x${h}.png`), Buffer.from(encoded, 'base64'))
  }
  const gpu = await page.evaluate(() => window.jap.gpuInfo())
  checks.gpu = gpu
  assert(gpu.adapters.length >= 1 && gpu.current.includes('ANGLE'), 'Physical GPU selector failed')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('渲染 GPU', { exact: true }).waitFor()
  assert(
    await page.getByRole('switch', { name: 'HDR 输出', exact: true }).isDisabled(),
    'SDR display should not offer HDR output'
  )
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    window.__jap.useUi.getState().setOnboardingOpen(true)
  })
  await page.locator('[data-onboarding]').waitFor()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.waitForFunction(() => window.__jap.useUi.getState().lyricsAdjusting)
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('slider', { name: '指导旋转 X', exact: true }).focus()
  await page.keyboard.press('Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('PageUp')
  for (let i = 0; i < 18; i++) await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: '保存并开始听歌', exact: true }).click()
  await page.evaluate(() => {
    const v = window.__jap.useViz.getState()
    v.setOffset({ x: 120, y: 35, z: 0 })
    v.setZoom(1.25)
  })
  await page.waitForTimeout(550)
  checks.savedPose = await page.evaluate(() => window.jap.updateSettings({}))
  assert(
    checks.savedPose.vizOffset.x === 120 &&
      checks.savedPose.vizZoom === 1.25 &&
      checks.savedPose.lyricsRotation.x === 18 &&
      checks.savedPose.onboardingComplete,
    'Stage pose was not persisted'
  )
  // Multiple jobs, five audio modes, and a waiting-job cancellation. The front
  // renderer remains available and its playback must keep advancing.
  const wav32 = join(out, 'true-32bit.wav')
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.11*sin(2*PI*997*t)|0.11*sin(2*PI*1013*t):s=96000:d=1',
      '-c:a',
      'pcm_s32le',
      wav32,
    ],
    { windowsHide: true }
  )
  const video = join(out, 'cover-film.mp4'),
    jobs = []
  for (const [audio, target, sourcePath] of [
    ['aac', video],
    ['flac', join(out, 'lossless.mkv')],
    ['pcm', join(out, 'pcm.mkv')],
    ['copy', join(out, 'original.mkv')],
    ['opus', join(out, 'opus.mkv')],
    ['flac', join(out, '32bit-flac.mkv'), wav32],
    ['aac', join(out, 'cancelled.mp4')],
  ]) {
    await answerNextFileDialog(page, target)
    jobs.push(
      await page.evaluate(
        async ({ path, audio }) =>
          window.__jap.exportVideo({
            path,
            width: audio === 'aac' ? 960 : 640,
            height: audio === 'aac' ? 540 : 360,
            fps: 24,
            quality: 23,
            encoder: 'cpu',
            intro: audio === 'aac' ? 2 : 0.25,
            outro: audio === 'aac' ? 2 : 0.25,
            start: 0,
            end: audio === 'aac' ? 2 : 1,
            lyrics: '3d',
            signature: 'B5 · 夜航',
            coverFont: 'noto-serif',
            audio,
            audioBitrate: 320,
          }),
        { path: sourcePath ?? flac, audio }
      )
    )
  }
  await page.evaluate((id) => window.jap.cancelVideoJob(id), jobs.at(-1).id)
  const before = await page.evaluate(() => ({
    position: window.__jap.usePlayer.getState().position.ms,
    state: window.__jap.usePlayer.getState().state,
    exportRunning: window.__jap.useVideoExport.getState().running,
    draw: window.__japViz.lastDraw,
  }))
  assert(
    before.state === 'playing' && !before.exportRunning,
    'Export occupied the foreground player'
  )
  await page.evaluate(() =>
    window.__jap.useSettings
      .getState()
      .update({ lyricsSize: 125, accent: '#22cdaa', renderFps: 24 })
  )
  await page.getByRole('button', { name: '导出队列', exact: true }).click()
  await page.screenshot({ path: join(out, 'export-queue.png') })
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () =>
      window.__jap.useVideoQueue
        .getState()
        .jobs.every((j) => ['done', 'failed', 'cancelled'].includes(j.state)),
    null,
    { timeout: 180000 }
  )
  checks.queue = await page.evaluate(() => window.__jap.useVideoQueue.getState().jobs)
  assert(checks.queue.filter((j) => j.state === 'done').length === 6, JSON.stringify(checks.queue))
  assert(checks.queue.at(-1).state === 'cancelled', 'Waiting cancellation failed')
  const after = await page.evaluate(() => ({
    position: window.__jap.usePlayer.getState().position.ms,
    state: window.__jap.usePlayer.getState().state,
    lyricsSize: window.__jap.useSettings.getState().lyricsSize,
    draw: window.__japViz.lastDraw,
  }))
  checks.foreground = { before, after }
  assert(
    after.state === 'playing' &&
      after.position > before.position &&
      after.draw > before.draw &&
      after.lyricsSize === 125,
    'Background export changed/stalled the front player'
  )
  checks.videoAudio = []
  for (const j of checks.queue.filter((j) => j.state === 'done'))
    checks.videoAudio.push(
      JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', j.target],
          { windowsHide: true, encoding: 'utf8' }
        )
      )
    )
  assert(
    checks.videoAudio
      .map((v) => v.streams.find((s) => s.codec_type === 'audio')?.codec_name)
      .join(',') === 'aac,flac,pcm_s32le,flac,opus,flac',
    'Audio quality codec mismatch'
  )
  const hash = (path, args = []) =>
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        ...args,
        '-i',
        path,
        '-map',
        '0:a:0',
        '-c:a',
        'copy',
        '-f',
        'hash',
        '-hash',
        'sha256',
        '-',
      ],
      { windowsHide: true, encoding: 'utf8' }
    ).trim()
  checks.originalStreamHash = hash(join(out, 'original.mkv'))
  assert(
    checks.originalStreamHash === hash(flac, ['-t', '1']),
    'Original audio packets were changed'
  )
  const pcmHash = (path) =>
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        path,
        '-map',
        '0:a:0',
        '-af',
        'atrim=end_sample=96000,asetpts=PTS-STARTPTS',
        '-c:a',
        'pcm_s32le',
        '-f',
        'hash',
        '-hash',
        'sha256',
        '-',
      ],
      { windowsHide: true, encoding: 'utf8' }
    ).trim()
  checks.flac32Hash = pcmHash(join(out, '32bit-flac.mkv'))
  assert(checks.flac32Hash === pcmHash(wav32), '32-bit FLAC discarded low-order sample bits')
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-ss', '1', '-i', video, '-frames:v', '1', join(out, 'video-intro.png')],
    { windowsHide: true }
  )
  assert(!logs.some((s) => /\[SMTC\].*失败/.test(s)), 'Native system media reported an error')
  assert(errors.length === 0, errors.join('\n'))
  console.log(JSON.stringify({ ok: true, checks, out }, null, 2))
} catch (e) {
  errors.push(String(e))
  process.exitCode = 1
  console.error(e)
} finally {
  await page
    .evaluate(() =>
      window.__jap?.useSettings.getState().update({ wallpaperEnabled: false, argbEnabled: false })
    )
    .catch(() => {})
  writeFileSync(join(out, 'results.json'), JSON.stringify({ checks, errors, logs }, null, 2))
  await app.close()
  for (const s of sockets) s.destroy()
  await new Promise((ok) => server.close(ok))
}
