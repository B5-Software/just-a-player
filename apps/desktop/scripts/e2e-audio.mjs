// Real Electron regression: rendered frames during resize/transitions, DSP,
// offline analysis, DSF playback and new audio instruments. Never opens hardware.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

const appDir = resolve(fileURLToPath(import.meta.url), '../..')
const output = resolve(process.argv[2] ?? join(tmpdir(), 'jap-audio-qa'))
mkdirSync(output, { recursive: true })
function wav(path) {
  const rate = 96000,
    seconds = 90,
    pcm = Buffer.alloc(rate * seconds * 6)
  for (let i = 0; i < rate * seconds; i++) {
    const x =
      Math.round(
        (0.25 * Math.sin((2 * Math.PI * 440 * i) / rate) +
          0.08 * Math.sin((2 * Math.PI * 3000 * i) / rate)) *
          32768
      ) * 256
    pcm.writeIntLE(x, i * 6, 3)
    pcm.writeIntLE(x, i * 6 + 3, 3)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF')
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(2, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 6, 28)
  h.writeUInt16LE(6, 32)
  h.writeUInt16LE(24, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  writeFileSync(path, Buffer.concat([h, pcm]))
}
function dsf(path) {
  const rate = 2822400,
    frames = (rate / 8) * 4,
    block = 4096,
    size = Math.ceil(frames / block) * block * 2
  const h = Buffer.alloc(92)
  h.write('DSD ')
  h.writeBigUInt64LE(28n, 4)
  h.writeBigUInt64LE(BigInt(92 + size), 12)
  h.write('fmt ', 28)
  h.writeBigUInt64LE(52n, 32)
  for (const [i, n] of [1, 0, 2, 2, rate, 1].entries()) h.writeUInt32LE(n, 40 + i * 4)
  h.writeBigUInt64LE(BigInt(frames * 8), 64)
  h.writeUInt32LE(block, 72)
  h.write('data', 80)
  h.writeBigUInt64LE(BigInt(size + 12), 84)
  writeFileSync(path, Buffer.concat([h, Buffer.alloc(size, 0x96)]))
}
const wavPath = join(output, 'padded-24bit-96k.wav'),
  dsdPath = join(output, 'DSD64-silence.dsf')
wav(wavPath)
dsf(dsdPath)
const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  cwd: appDir,
  env: { ...process.env, JAP_E2E: 'audio' },
})
const page = await app.firstWindow(),
  errors = [],
  checks = {}
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
try {
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  await page.evaluate((path) => {
    const j = window.__jap
    j.useViz.getState().setAuto(false)
    j.useSettings
      .getState()
      .update({ lyricsVisible: false, wallpaperEnabled: false, argbEnabled: false })
    j.useViz.getState().resetPosition()
    j.useViz.getState().setScene('orb')
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
    j.usePlayer.getState().setVolume(1)
    j.useDsp.getState().update({ enabled: false })
    j.usePlayer.getState().play(path)
  }, wavPath)
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'playing')
  await page.waitForFunction(() => window.__jap.useQuality.getState().report !== null, null, {
    timeout: 30000,
  })
  checks.quality = await page.evaluate(() => window.__jap.useQuality.getState().report)
  assert(
    checks.quality.score >= 0 && checks.quality.score <= 100,
    'Missing numeric integrity score'
  )
  assert(
    checks.quality.effectiveBits === 16,
    'Padded 24-bit source was not detected as 16 effective integer bits'
  )
  await page.evaluate(() => window.__jap.usePlayer.getState().setVolume(0.2))
  await page.waitForFunction(() => window.__jap.usePlayer.getState().volume === 0.2)
  const resetBefore = await page.evaluate(() => window.__jap.usePlayer.getState().bufferResets)
  await page.getByRole('button', { name: '重置音频缓冲', exact: true }).click()
  await page.waitForFunction((n) => window.__jap.usePlayer.getState().bufferResets > n, resetBefore)
  checks.bufferReset = true
  await page.evaluate(() => window.__jap.usePlayer.getState().setVolume(1))
  for (const name of ['外观', 'DSP / EQ', '音源分析', '外观'])
    await page.getByRole('button', { name, exact: true }).click()
  await page.waitForTimeout(400)
  await page.getByRole('switch', { name: '自动取色', exact: true }).click()
  assert(
    (await page.locator('[data-panel-root="appearance"]').count()) === 1,
    'Inside switch closed the panel'
  )
  await page.getByRole('button', { name: '靛紫', exact: true }).click()
  await page.screenshot({ path: join(output, 'accent-focus.png') })
  await page.keyboard.press('Escape')
  checks.switches = await page.locator('input[type="checkbox"]').count()
  assert(checks.switches === 0, 'Unstyled checkbox remains')
  await page.getByRole('button', { name: 'DSP / EQ', exact: true }).click()
  await page.getByLabel('音效预置', { exact: true }).click()
  await page.getByRole('option', { name: '温暖', exact: true }).click()
  await page.waitForFunction(() => window.__jap.useDsp.getState().config.enabled)
  checks.dsp = await page.evaluate(() => ({
    config: window.__jap.useDsp.getState().config,
    path: window.__jap.usePlayer.getState().signalPath,
  }))
  assert(checks.dsp.path.verdict === 'processed', 'DSP must mark signal as processed')
  assert(
    checks.dsp.path.nodes.some((n) => n.kind === 'dsp'),
    'DSP node missing'
  )
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(output, 'dsp.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '音源分析', exact: true }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(output, 'quality.png') })
  await page.keyboard.press('Escape')
  const identity = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id
  )
  checks.beforeMini = await page.evaluate(() => ({
    state: window.__jap.usePlayer.getState().state,
    position: window.__jap.usePlayer.getState().position,
    error: window.__jap.usePlayer.getState().error,
  }))
  assert(
    (await page.evaluate(() => window.jap.setWindowMode('mini'))) === 'mini',
    'Mini mode failed'
  )
  assert(
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1,
    'Mini mode created duplicate window'
  )
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(output, 'mini.png') })
  await page.evaluate(() => window.jap.setWindowMode('normal'))
  assert(
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id)) ===
      identity,
    'Mini mode replaced renderer'
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
  await page.waitForTimeout(300)
  const drawAt = await page.evaluate(() => window.__japViz.lastDraw)
  await page.waitForTimeout(400)
  assert(
    (await page.evaluate(() => window.__japViz.lastDraw)) === drawAt,
    'Minimized window continues GPU rendering'
  )
  checks.afterMinimize = await page.evaluate(() => ({
    state: window.__jap.usePlayer.getState().state,
    position: window.__jap.usePlayer.getState().position,
    error: window.__jap.usePlayer.getState().error,
  }))
  assert(
    checks.afterMinimize.state === 'playing',
    `Minimizing interrupted playback: ${JSON.stringify(checks.afterMinimize)}`
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
  await page.waitForTimeout(300)
  checks.minimizeSuspends = true
  for (const scene of ['scope', 'spectrum', 'spectrogram', 'vectorscope']) {
    await page.evaluate((id) => window.__jap.useViz.getState().setScene(id), scene)
    await page.waitForTimeout(scene === 'spectrogram' ? 2500 : 850)
    await page.screenshot({ path: join(output, `${scene}.png`) })
  }
  await page.evaluate(() => {
    window.__jap.useViz.getState().setScene('spectrum')
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 54
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    window.__frames = {
      total: 0,
      black: 0,
      minPeak: 255,
      running: true,
      contextLosses: 0,
      blanks: [],
    }
    window.__japViz.renderer.domElement.addEventListener(
      'webglcontextlost',
      () => window.__frames.contextLosses++
    )
    const sample = () => {
      const f = window.__frames
      if (!f.running) return
      ctx.drawImage(window.__japViz.presentedFrame, 0, 0, 96, 54)
      const pixels = ctx.getImageData(0, 0, 96, 54).data
      let peak = 0
      for (let i = 0; i < pixels.length; i += 4)
        peak = Math.max(peak, pixels[i], pixels[i + 1], pixels[i + 2])
      f.total++
      f.minPeak = Math.min(f.minPeak, peak)
      if (peak < 20) {
        f.black++
        const v = window.__japViz
        f.blanks.push({
          at: performance.now(),
          scene: v.currentId,
          fade: v.fade,
          size: [v.width, v.height],
          hasFrame: v.hasFrame,
          hidden: document.hidden,
          pending: v.pendingId,
        })
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  for (let i = 0; i < 28; i++) {
    await app.evaluate(
      ({ BrowserWindow }, i) =>
        BrowserWindow.getAllWindows()[0].setSize(1000 + (i % 7) * 45, 680 + (i % 5) * 26),
      i
    )
    if (i % 4 === 0)
      await page.evaluate(
        (id) => window.__jap.useViz.getState().setScene(id),
        ['scope', 'spectrum', 'spectrogram', 'vectorscope'][Math.floor(i / 4) % 4]
      )
    await page.waitForTimeout(80)
  }
  const beforeCycle = await page.evaluate(() => {
    window.__jap.useViz.getState().setAuto(true)
    return window.__jap.useViz.getState().sceneId
  })
  // Cross the 42-second automatic scene boundary while continuing to capture.
  await page.waitForTimeout(process.env.JAP_QA_FAST ? 1500 : 43500)
  checks.frames = await page.evaluate(() => {
    window.__frames.running = false
    return { ...window.__frames, afterCycle: window.__jap.useViz.getState().sceneId }
  })
  if (!process.env.JAP_QA_FAST)
    assert(checks.frames.afterCycle !== beforeCycle, 'Automatic scene cycle did not run')
  assert(checks.frames.total > 100, 'Frame sampler did not run')
  assert(checks.frames.black === 0, `Saw ${checks.frames.black} black rendered frames`)
  assert(checks.frames.contextLosses === 0, 'WebGL context was lost')
  const canRecover = await page.evaluate(() => {
    const ext = window.__japViz.renderer.getContext().getExtension('WEBGL_lose_context')
    if (!ext) return false
    window.__contextExtension = ext
    ext.loseContext()
    return true
  })
  if (canRecover) {
    await page.waitForTimeout(300)
    checks.contextFallback = await page.evaluate(
      () => window.__japViz.renderer.domElement.style.visibility === 'hidden'
    )
    assert(checks.contextFallback, 'Context loss should show the cached frame')
    await page.evaluate(() => window.__contextExtension.restoreContext())
    await page.waitForFunction(
      () =>
        !window.__japViz.contextLost &&
        window.__japViz.renderer.domElement.style.visibility === 'visible',
      null,
      { timeout: 10000 }
    )
    checks.contextRecovered = true
  }
  await page.evaluate((path) => {
    const j = window.__jap
    j.useViz.getState().setAuto(false)
    j.useDsp.getState().update({ enabled: false })
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'dop' })
    j.usePlayer.getState().play(path)
  }, dsdPath)
  await page.waitForFunction(() => window.__jap.usePlayer.getState().track?.format.bits === 1)
  checks.dsd = await page.evaluate(() => ({
    track: window.__jap.usePlayer.getState().track,
    signal: window.__jap.usePlayer.getState().signalPath,
  }))
  assert(checks.dsd.signal.verdict === 'bitPerfect', 'DSD DoP must retain the original bitstream')
  await page.getByRole('button', { name: '信号链', exact: true }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(output, 'dsd-signal.png') })
  assert(errors.length === 0, `Renderer errors: ${errors.join('\n')}`)
  console.log(JSON.stringify({ ok: true, checks, output }, null, 2))
} catch (error) {
  errors.push(String(error))
  process.exitCode = 1
  console.error(error)
} finally {
  writeFileSync(join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
  await app.close()
}
