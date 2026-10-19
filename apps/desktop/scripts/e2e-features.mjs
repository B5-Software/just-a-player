// New-feature regression in real Electron; null audio output only.
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createCipheriv } from 'node:crypto'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
const appDir = resolve(fileURLToPath(import.meta.url), '../..'),
  out = join(tmpdir(), 'jap-features-qa'),
  dir = join(out, 'album')
mkdirSync(dir, { recursive: true })
const wav = join(dir, '同名歌曲.wav'),
  mp3 = join(dir, '同名歌曲.mp3'),
  flac = join(dir, '同名歌曲.flac'),
  ncm = join(out, '加密测试.ncm'),
  dts = join(out, 'test.dts')
execFileSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=12:sample_rate=48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s24le',
    wav
  ],
  { windowsHide: true }
)
execFileSync(
  'ffmpeg',
  ['-v', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '128k', mp3],
  { windowsHide: true }
)
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'flac', flac], {
  windowsHide: true
})
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'dca', '-strict', '-2', dts], {
  windowsHide: true
})
writeFileSync(
  join(dir, '同名歌曲.lrc'),
  '[00:00.00]原生歌词 · 测试\n[00:01.00]跟随强调色与音乐\n[00:02.00]不重复渲染\n[00:03.00]导出完成'
)
const aes = (key, data) => {
  const c = createCipheriv('aes-128-ecb', Buffer.from(key), null)
  return Buffer.concat([c.update(data), c.final()])
}
const key = Buffer.from('test-key-seekable-stream'),
  encryptedKey = aes(
    'hzHRAmso5kInbaxW',
    Buffer.concat([Buffer.from('neteasecloudmusic'), key])
  ).map((b) => b ^ 0x64)
const box = Uint8Array.from({ length: 256 }, (_, i) => i)
let j = 0
for (let i = 0; i < 256; i++) {
  j = (j + box[i] + key[i % key.length]) & 255
  ;[box[i], box[j]] = [box[j], box[i]]
}
const mask = Uint8Array.from({ length: 256 }, (_, i) => {
  const j = (i + 1) & 255
  return box[(box[j] + box[(box[j] + j) & 255]) & 255]
})
const meta = Buffer.concat([
  Buffer.from("163 key(Don't modify):"),
  Buffer.from(
    aes(
      "#14ljk_!\\]&0U<'(",
      Buffer.from(
        'music:' + JSON.stringify({ musicName: 'NCM 流式测试', artist: [['B5', 1]], album: 'Rust' })
      )
    ).toString('base64')
  )
]).map((b) => b ^ 0x63)
const size = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
writeFileSync(
  ncm,
  Buffer.concat([
    Buffer.from('CTENFDAM\0\0'),
    size(encryptedKey.length),
    encryptedKey,
    size(meta.length),
    meta,
    Buffer.alloc(13),
    readFileSync(wav).map((b, i) => b ^ mask[i & 255])
  ])
)
const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  cwd: appDir,
  env: { ...process.env, JAP_E2E: 'features' }
})
const page = await app.firstWindow(),
  checks = {},
  errors = []
page.setDefaultTimeout(60000)
page.on('pageerror', (e) => errors.push(e.message))
const assert = (v, m) => {
  if (!v) throw new Error(m)
}
try {
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  const gradient = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 128
    c.height = 128
    const x = c.getContext('2d')
    const g = x.createLinearGradient(0, 0, 128, 128)
    g.addColorStop(0, '#fb3682')
    g.addColorStop(1, '#146fb5')
    x.fillStyle = g
    x.fillRect(0, 0, 128, 128)
    return c.toDataURL().split(',')[1]
  })
  writeFileSync(join(dir, 'cover.png'), Buffer.from(gradient, 'base64'))
  await page.evaluate(() => {
    const j = window.__jap
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
    j.usePlayer.getState().setVolume(0.2)
    j.useDsp.getState().update({ enabled: false })
    j.useSettings.getState().update({
      wallpaperEnabled: false,
      argbEnabled: false,
      autoScan: false,
      lyricsVisible: true,
      lyricsFont: 'ma-shan-zheng',
      renderFps: 0
    })
    j.useViz.getState().setAuto(false)
  })
  checks.ncm = await page.evaluate(
    async (path) => await window.__jap.usePlayer.getState().probe(path),
    ncm
  )
  assert(
    checks.ncm?.title === 'NCM 流式测试' && checks.ncm.codec.startsWith('NCM'),
    'NCM metadata/decryption failed'
  )
  checks.dts = await page.evaluate(
    async (path) => await window.__jap.usePlayer.getState().probe(path),
    dts
  )
  assert(checks.dts?.codec.includes('DTS'), 'DTS fallback decoder failed')
  await page.evaluate(async (dir) => {
    const j = window.__jap
    j.useLibrary.getState().createList('目录优选测试')
    await j.addAudioPaths([dir], false)
  }, dir)
  checks.import = await page.evaluate(() => {
    const j = window.__jap
    return j.useLibrary.getState().lists.find((l) => l.id === j.useLibrary.getState().activeListId)
      .items
  })
  assert(
    checks.import.length === 1 && checks.import[0].path.endsWith('.flac'),
    'Import did not deterministically select the better lossless file'
  )
  await page.evaluate(() => {
    const j = window.__jap
    const s = j.useLibrary.getState()
    j.playItem(s.activeListId, s.lists.find((l) => l.id === s.activeListId).items[0].id)
  })
  await page.waitForFunction(() => window.__jap.useLyrics.getState().text?.includes('原生歌词'))
  checks.lyrics = true
  await page.evaluate(async (path) => {
    window.__jap.usePlayer.getState().play(path)
  }, ncm)
  await page.waitForFunction(() => window.__jap.usePlayer.getState().track?.codec.startsWith('NCM'))
  await page.evaluate((path) => window.__jap.usePlayer.getState().play(path), flac)
  await page.waitForFunction(() => window.__jap.useCover.getState().backdrop !== null)
  await page.evaluate(() => {
    window.__jap.useViz.getState().setScene('spectrum')
    window.__jap.useSettings.getState().update({ backdropBrightness: 0.65 })
  })
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(out, 'transparent-instrument.png') })
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.waitForTimeout(300)
  await page.getByRole('switch', { name: '自动取色', exact: true }).focus()
  await page.keyboard.press('Tab')
  checks.focus = await page.evaluate(() => ({
    outline: getComputedStyle(document.activeElement).outlineColor,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent-focus').trim()
  }))
  assert(checks.focus.outline !== 'rgb(255, 255, 0)', 'System yellow focus remains')
  await page.screenshot({ path: join(out, 'accent-keyboard-focus.png') })
  await page.keyboard.press('Escape')
  const wallCreated = app.waitForEvent('window')
  checks.wallpaper = await page.evaluate(() => window.jap.setWindowMode('wallpaper'))
  const wall = await wallCreated
  await wall.waitForFunction(
    () => window.__japViz && document.documentElement.dataset.renderSuspended !== '1'
  )
  const beforeWallpaperDraw = await wall.evaluate(() => window.__japViz.lastDraw)
  await page.waitForTimeout(300)
  assert(
    (await wall.evaluate(() => window.__japViz.lastDraw)) > beforeWallpaperDraw,
    'Wallpaper is not drawing'
  )
  await page.evaluate(() => window.jap.setWindowMode('normal'))
  await page.evaluate(() => window.__jap.useSettings.getState().update({ wallpaperEnabled: false }))
  checks.wallpaperRestored = true
  await page.evaluate(() => window.__jap.useViz.getState().setScene('orb'))
  await page.waitForTimeout(750)
  const video = join(out, 'render-test.mp4')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, video)
  const started = Date.now()
  await page.evaluate(async (path) => {
    await window.__jap.exportVideo({
      path,
      width: 640,
      height: 360,
      fps: 24,
      quality: 23,
      encoder: 'cpu',
      intro: 0.5,
      outro: 0.5,
      start: 0,
      end: 2,
      lyrics: '3d'
    })
  }, flac)
  await page.waitForFunction(
    () =>
      window.__jap.useVideoQueue.getState().jobs[0]?.state === 'done' ||
      window.__jap.useVideoQueue.getState().jobs[0]?.state === 'failed',
    null,
    { timeout: 120000 }
  )
  checks.export = await page.evaluate(() => window.__jap.useVideoQueue.getState().jobs[0])
  const worker = app.windows().find((p) => p.url().includes('surface=export'))
  checks.renderMs = Date.now() - started
  for (const [key, name] of [
    ['__exportStage', 'stage-frame.png'],
    ['__exportLyrics', 'lyrics-frame.png']
  ]) {
    const data = await worker.evaluate((key) => window[key], key)
    if (data) writeFileSync(join(out, name), Buffer.from(data.split(',')[1], 'base64'))
  }
  assert(
    !checks.export.error && checks.export.target === video,
    `Video export failed: ${checks.export.error}`
  )
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video],
      { windowsHide: true, encoding: 'utf8' }
    )
  )
  checks.video = probe.streams.map((s) => ({
    codec: s.codec_name,
    width: s.width,
    height: s.height,
    frames: s.nb_frames,
    duration: s.duration
  }))
  assert(
    probe.streams.some((s) => s.codec_name === 'h264' && s.width === 640 && s.height === 360),
    'Export video stream mismatch'
  )
  assert(
    probe.streams.some((s) => s.codec_name === 'aac'),
    'Export audio stream missing'
  )
  assert(
    Math.abs(Number(probe.format.duration) - 3) < 0.1,
    'Video timeline does not match requested intro/music/outro'
  )
  assert(statSync(video).size > 10000, 'Video output empty')
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-ss',
      '1.2',
      '-i',
      video,
      '-frames:v',
      '1',
      join(out, 'export-frame.png')
    ],
    { windowsHide: true }
  )
  const completedSize = statSync(video).size
  const cancelJob = await page.evaluate(
    (path) =>
      window.__jap.exportVideo({
        path,
        width: 1280,
        height: 720,
        fps: 24,
        quality: 23,
        encoder: 'cpu',
        intro: 0,
        outro: 0,
        start: 0,
        end: 8,
        lyrics: '3d'
      }),
    flac
  )
  await page.waitForFunction(
    (id) => window.__jap.useVideoQueue.getState().jobs.find((j) => j.id === id)?.progress > 0,
    cancelJob.id
  )
  await page.evaluate((id) => window.jap.cancelVideoJob(id), cancelJob.id)
  await page.waitForFunction(
    (id) =>
      window.__jap.useVideoQueue.getState().jobs.find((j) => j.id === id)?.state === 'cancelled',
    cancelJob.id
  )
  assert(statSync(video).size === completedSize, 'Cancellation damaged the completed video')
  checks.cancel = true
  const original = join(out, 'ncm-original.mkv')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, original)
  const ncmJob = await page.evaluate(
    (path) =>
      window.__jap.exportVideo({
        path,
        width: 640,
        height: 360,
        fps: 24,
        quality: 23,
        encoder: 'cpu',
        intro: 0,
        outro: 0,
        start: 0,
        end: 1,
        lyrics: 'none',
        audio: 'copy'
      }),
    ncm
  )
  await page.waitForFunction(
    (id) =>
      ['done', 'failed'].includes(
        window.__jap.useVideoQueue.getState().jobs.find((j) => j.id === id)?.state
      ),
    ncmJob.id
  )
  checks.ncmCopy = await page.evaluate(
    (id) => window.__jap.useVideoQueue.getState().jobs.find((j) => j.id === id),
    ncmJob.id
  )
  assert(checks.ncmCopy.state === 'done', JSON.stringify(checks.ncmCopy))
  assert(errors.length === 0, errors.join('\n'))
  console.log(JSON.stringify({ ok: true, checks, out }, null, 2))
} catch (error) {
  errors.push(String(error))
  process.exitCode = 1
  console.error(error)
} finally {
  await page.evaluate(() => window.jap.setWindowMode('normal')).catch(() => {})
  writeFileSync(join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
  await app.close()
}
