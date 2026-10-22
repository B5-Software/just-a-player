import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { answerNextFileDialog } from './e2e-dialog-helper.mjs'
import { graphicsArgs } from './e2e-graphics.mjs'
const cwd = fileURLToPath(new URL('..', import.meta.url)),
  out = path.join(cwd, 'test-results/export-isolation')
fs.mkdirSync(out, { recursive: true })
const wav = path.join(out, 'Original Export Tone.wav'),
  rate = 48000,
  n = rate * 180,
  b = Buffer.alloc(44 + n * 4)
b.write('RIFF')
b.writeUInt32LE(b.length - 8, 4)
b.write('WAVEfmt ', 8)
b.writeUInt32LE(16, 16)
b.writeUInt16LE(1, 20)
b.writeUInt16LE(2, 22)
b.writeUInt32LE(rate, 24)
b.writeUInt32LE(rate * 4, 28)
b.writeUInt16LE(4, 32)
b.writeUInt16LE(16, 34)
b.write('data', 36)
b.writeUInt32LE(n * 4, 40)
for (let i = 0; i < n; i++) {
  const v = Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 1000)
  b.writeInt16LE(v, 44 + i * 4)
  b.writeInt16LE(v, 46 + i * 4)
}
fs.writeFileSync(wav, b)
const app = await electron.launch({
  executablePath: electronPath,
  args: ['.', ...graphicsArgs],
  cwd,
  env: { ...process.env, JAP_E2E: 'export-isolation' },
})
const page = await app.firstWindow(),
  checks = []
try {
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  await page.evaluate(() => {
    const j = window.__jap
    j.useUi.getState().setOnboardingOpen(false)
    j.useSettings.getState().update({
      legacyVisuals: false,
      disabledVisuals: [],
      renderFps: 30,
      autoBackdrop: false,
      lyricsVisible: false,
      autoAccent: false,
      accent: '#8b9fd9',
    })
    j.usePlayer.getState().setOutput({ api: 'null' })
    j.useViz.getState().setScene('silk-studio')
    j.useViz.getState().setOffset({ x: 80, y: -25, z: 0 })
    j.useViz.getState().setZoom(1)
    window.__gaps = []
    let last = performance.now()
    window.__pulse = setInterval(() => {
      const t = performance.now()
      __gaps.push(t - last)
      last = t
    }, 50)
  })
  await page.evaluate((p) => window.__jap.usePlayer.getState().play(p), wav)
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'playing')
  const target = path.join(out, 'GPU export.mp4')
  await answerNextFileDialog(page, target)
  await page.evaluate(
    (p) =>
      window.__jap.exportVideo({
        path: p,
        width: 640,
        height: 360,
        fps: 30,
        quality: 18,
        encoder: 'auto',
        audio: 'aac',
        intro: 0,
        outro: 0,
        start: 0,
        end: 2,
        lyrics: 'none',
        renderPriority: 'balanced',
      }),
    wav
  )
  await page.waitForFunction(() =>
    window.__jap.useVideoQueue.getState().jobs.some((j) => j.state === 'rendering')
  )
  const worker = app.windows().find((p) => p !== page)
  assert.ok(worker)
  const mainPid = await page.evaluate(() => window.jap.surface),
    surface = await worker.evaluate(() => window.jap.surface)
  assert.equal(mainPid, 'main')
  assert.equal(surface, 'export')
  const pids = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.webContents.getOSProcessId())
  )
  assert.equal(new Set(pids).size, pids.length, 'Export must have its own renderer process')
  await worker.waitForFunction(() => Boolean(window.__exportStage), null, { timeout: 90000 })
  const original = await worker.evaluate(() => window.__exportStage)
  await page.waitForFunction(
    () =>
      window.__jap.useVideoQueue
        .getState()
        .jobs.every((j) => ['done', 'failed', 'cancelled'].includes(j.state)),
    null,
    { timeout: 90000 }
  )
  const jobs = await page.evaluate(() => window.__jap.useVideoQueue.getState().jobs)
  assert.ok(
    jobs.every((j) => j.state === 'done'),
    JSON.stringify(jobs)
  )
  assert.equal(await page.evaluate(() => window.__jap.usePlayer.getState().state), 'playing')
  const gaps = await page.evaluate(() => {
    clearInterval(__pulse)
    return __gaps
  })
  assert.ok(Math.max(...gaps) < 1500, 'Foreground became unresponsive: ' + Math.max(...gaps))
  checks.push(
    'Video is generated offline in a separate renderer; foreground playback and event loop continue'
  )
  const ffprobe = path.join(cwd, 'build/media-tools/bin/ffprobe.exe'),
    ffmpeg = path.join(cwd, 'build/media-tools/bin/ffmpeg.exe')
  const probe = JSON.parse(
    execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', target], {
      encoding: 'utf8',
      windowsHide: true,
    })
  )
  assert.equal(probe.streams.find((s) => s.codec_type === 'video').nb_frames, '60')
  assert.ok(probe.streams.some((s) => s.codec_type === 'audio'))
  checks.push('Export contains the expected 60 frames and an audio track')
  // The worker's pre-encode frame is captured at frame 30 by the debug harness.
  let ssim = 0
  if (original) {
    const image = path.join(out, 'reference.png')
    fs.writeFileSync(image, Buffer.from(original.split(',')[1], 'base64'))
    const decoded = path.join(out, 'decoded.png')
    execFileSync(
      ffmpeg,
      ['-v', 'error', '-y', '-i', target, '-vf', 'select=eq(n\\,30)', '-frames:v', '1', decoded],
      { windowsHide: true }
    )
    const result = spawnSync(
      ffmpeg,
      ['-i', image, '-i', decoded, '-lavfi', 'ssim', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true }
    )
    assert.equal(result.status, 0, result.stderr)
    ssim = Number(result.stderr.match(/All:([0-9.]+)/)?.[1])
    assert.ok(ssim > 0.94, 'Encoded picture diverged from the shared renderer: ' + ssim)
    checks.push('Encoded output compared against the exact shared-renderer source frame')
  }
  await answerNextFileDialog(page, path.join(out, 'cancel.mp4'))
  await page.evaluate(
    (p) =>
      window.__jap.exportVideo({
        path: p,
        width: 640,
        height: 360,
        fps: 30,
        quality: 18,
        encoder: 'auto',
        audio: 'aac',
        intro: 0,
        outro: 0,
        start: 0,
        end: 20,
        lyrics: 'none',
      }),
    wav
  )
  await page.waitForFunction(
    () => window.__jap.useVideoQueue.getState().jobs.at(-1)?.state === 'rendering'
  )
  await page.evaluate(() =>
    window.jap.cancelVideoJob(window.__jap.useVideoQueue.getState().jobs.at(-1).id)
  )
  await page.waitForFunction(
    () => window.__jap.useVideoQueue.getState().jobs.at(-1)?.state === 'cancelled'
  )
  await answerNextFileDialog(page, path.join(out, 'after-cancel.mp4'))
  await page.evaluate(
    (p) =>
      window.__jap.exportVideo({
        path: p,
        width: 320,
        height: 180,
        fps: 24,
        quality: 28,
        encoder: 'cpu',
        audio: 'aac',
        intro: 0,
        outro: 0,
        start: 0,
        end: 0.25,
        lyrics: 'none',
      }),
    wav
  )
  await page.waitForFunction(
    () => ['done', 'failed'].includes(window.__jap.useVideoQueue.getState().jobs.at(-1)?.state),
    null,
    { timeout: 90000 }
  )
  assert.equal(
    await page.evaluate(() => window.__jap.useVideoQueue.getState().jobs.at(-1).state),
    'done'
  )
  checks.push('Cancellation releases the worker immediately and the next export completes')
  const report = {
    status: 'passed',
    checks,
    ssim,
    maxForegroundGapMs: Math.max(...gaps),
    streams: probe.streams.map((s) => ({
      type: s.codec_type,
      codec: s.codec_name,
      frames: s.nb_frames,
    })),
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app.close()
}
