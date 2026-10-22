import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { writeMidi } from '../../../scripts/fixtures/midi.mjs'
import { graphicsArgs } from './e2e-graphics.mjs'
import { tmpdir } from 'node:os'
const appDir = fileURLToPath(new URL('..', import.meta.url)),
  out = path.join(appDir, 'test-results/midi-touch')
fs.mkdirSync(out, { recursive: true })
const midi = path.join(out, '你好 #音符.mid'),
  wav = path.join(out, '你好 #音符.wav')
writeMidi(midi, 240)
const preferences = path.join(tmpdir(), 'jap-e2e-userdata/settings.json')
fs.mkdirSync(path.dirname(preferences), { recursive: true })
fs.writeFileSync(
  preferences,
  JSON.stringify({
    onboardingComplete: true,
    autoScan: false,
    legacyVisuals: false,
    renderFps: 15,
    renderScale: 0.5,
    midiSoundfont: '',
    autoHideControls: false,
  })
)
const samples = 44100 * 120,
  buffer = Buffer.alloc(44 + samples * 4)
buffer.write('RIFF')
buffer.writeUInt32LE(buffer.length - 8, 4)
buffer.write('WAVEfmt ', 8)
buffer.writeUInt32LE(16, 16)
buffer.writeUInt16LE(1, 20)
buffer.writeUInt16LE(2, 22)
buffer.writeUInt32LE(44100, 24)
buffer.writeUInt32LE(176400, 28)
buffer.writeUInt16LE(4, 32)
buffer.writeUInt16LE(16, 34)
buffer.write('data', 36)
buffer.writeUInt32LE(samples * 4, 40)
for (let i = 0; i < samples; i++) {
  const n = Math.round(Math.sin((i * Math.PI * 880) / 44100) * 800)
  buffer.writeInt16LE(n, 44 + i * 4)
  buffer.writeInt16LE(n, 46 + i * 4)
}
fs.writeFileSync(wav, buffer)
const app = await electron.launch({
  executablePath: electronPath,
  args: ['.', ...graphicsArgs, midi, wav],
  cwd: appDir,
  env: { ...process.env, JAP_E2E: 'midi-touch' },
})
const page = await app.firstWindow(),
  errors = [],
  checks = []
page.on('pageerror', (e) => errors.push(e.message))
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  await page.waitForFunction(
    () => window.__jap?.usePlayer.getState().track?.codec.startsWith('MIDI'),
    null,
    { timeout: 60000 }
  )
  const info = await page.evaluate(() => window.__jap.usePlayer.getState().track)
  assert.equal(info.format.sampleRate, 96000)
  assert.equal(info.format.float, true)
  assert.ok(info.durationMs > 10000)
  const external = await page.evaluate(() =>
    window.__jap.useLibrary.getState().lists.find((l) => l.id === 'jap-external-files')
  )
  assert.ok(external.items.some((i) => i.path === midi))
  assert.ok(external.items.some((i) => i.path === wav))
  checks.push('Cold launch opens MIDI; same-name MIDI and WAV both retained')
  await page.evaluate(() => window.__jap.usePlayer.getState().seek(1000))
  await page.waitForFunction(() => window.__jap.usePlayer.getState().position.ms >= 1000)
  checks.push('MIDI seek works through the real Rust synth')
  await page.evaluate((path) => {
    const j = window.__jap
    j.useLibrary.getState().createList('保留测试歌单')
    j.usePlayer.getState().play(path)
    j.useViz.getState().setAuto(false)
    j.useViz.getState().setScene('orb')
    j.useSettings.getState().update({ renderFps: 30, autoHideControls: false })
  }, wav)
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'playing')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  let touchClock = 0
  const touch = (type, x, y, offset) => {
    if (type === 'touchStart') touchClock = Date.now()
    return cdp.send('Input.dispatchTouchEvent', {
      type,
      timestamp: (offset === undefined ? Date.now() : touchClock + offset) / 1000,
      touchPoints:
        type === 'touchEnd' || type === 'touchCancel'
          ? []
          : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    })
  }
  const tap = async (x, y) => {
    await touch('touchStart', x, y)
    await touch('touchEnd')
  }
  const drag = async (x, y, dx, dy, hold = 0) => {
    await touch('touchStart', x, y)
    if (hold) await delay(hold)
    for (let n = 1; n <= 5; n++) {
      await touch('touchMove', x + (dx * n) / 5, y + (dy * n) / 5, hold + n * 20)
      await delay(20)
    }
    await touch('touchEnd')
  }
  await page.evaluate(() => window.__jap.useViz.getState().setOffset({ x: 0, y: 0 }))
  await drag(260, 360, 125, 25)
  let offset = await page.evaluate(() => window.__jap.useViz.getState().offset)
  assert.ok(offset.x >= 115, JSON.stringify(offset))
  await touch('touchStart', 260, 360)
  await touch('touchMove', 280, 365)
  await touch('touchCancel')
  offset = await page.evaluate(() => window.__jap.useViz.getState().offset)
  await page.mouse.move(520, 410)
  await delay(50)
  assert.deepEqual(await page.evaluate(() => window.__jap.useViz.getState().offset), offset)
  checks.push('Touch drag continues beyond pan threshold; cancellation releases capture')
  await page.evaluate(() => {
    document.activeElement?.blur()
    window.__jap.useSettings.getState().update({ autoHideControls: true })
  })
  await delay(3700)
  assert.equal(
    await page.locator('[data-player-topbar]').evaluate((e) => getComputedStyle(e).opacity),
    '0'
  )
  await tap(260, 360)
  await delay(400)
  assert.equal(
    await page.locator('[data-player-topbar]').evaluate((e) => getComputedStyle(e).opacity),
    '1'
  )
  checks.push('Tap without movement wakes hidden controls')
  await page.evaluate(() => window.__jap.useSettings.getState().update({ autoHideControls: false }))
  await page.evaluate(() => window.__jap.usePlayer.getState().setVolume(0.2))
  await page.waitForFunction(() => Math.abs(window.__jap.usePlayer.getState().volume - 0.2) < 0.001)
  const volume = page.getByRole('slider', { name: '应用内音量', exact: true }),
    r = await volume.boundingBox()
  const initial = await volume.getAttribute('aria-valuenow')
  await tap(r.x + r.width * 0.9, r.y + r.height / 2)
  assert.equal(await volume.getAttribute('aria-valuenow'), initial)
  await drag(r.x + r.width * 0.5, r.y + r.height / 2, 0, -70)
  assert.equal(await volume.getAttribute('aria-valuenow'), initial)
  await drag(r.x + r.width * 0.2, r.y + r.height / 2, r.width * 0.4, 0)
  await delay(100)
  assert.ok(Number(await volume.getAttribute('aria-valuenow')) > Number(initial) + 20)
  checks.push(
    'Touch sliders ignore taps and vertical scrolls; deliberate horizontal drag adjusts volume'
  )
  const seek = page.getByRole('slider', { name: '播放进度', exact: true }),
    sr = await seek.boundingBox(),
    before = Number(await seek.getAttribute('aria-valuenow'))
  await tap(sr.x + sr.width * 0.9, sr.y + sr.height / 2)
  assert.ok(Number(await seek.getAttribute('aria-valuenow')) < before + 2000)
  checks.push('Touch tap does not accidentally seek')
  await page.evaluate(() => window.__jap.useDsp.getState().update({ eqDb: Array(10).fill(0) }))
  await page.getByRole('button', { name: 'DSP / EQ', exact: true }).click()
  await delay(250)
  const eq = page.getByRole('slider', { name: 'EQ 31.25 Hz', exact: true }),
    er = await eq.boundingBox(),
    eqInitial = await eq.getAttribute('aria-valuenow')
  await drag(er.x + er.width / 2, er.y + er.height / 2, 0, -25)
  assert.equal(await eq.getAttribute('aria-valuenow'), eqInitial)
  const er2 = await eq.boundingBox()
  await drag(er2.x + er2.width / 2, er2.y + er2.height / 2, 0, -25, 220)
  assert.notEqual(await eq.getAttribute('aria-valuenow'), eqInitial)
  checks.push('Vertical EQ rejects scroll gestures and accepts hold-then-drag')
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__jap.useSettings.getState().update({ keepScreenAwake: true }))
  await delay(1200)
  assert.ok(
    await app.evaluate(({ powerSaveBlocker }) =>
      Array.from({ length: 64 }, (_, i) => i).some((i) => powerSaveBlocker.isStarted(i))
    )
  )
  await page.evaluate(() => window.__jap.usePlayer.getState().togglePause())
  await delay(1000)
  assert.ok(
    !(await app.evaluate(({ powerSaveBlocker }) =>
      Array.from({ length: 64 }, (_, i) => i).some((i) => powerSaveBlocker.isStarted(i))
    ))
  )
  checks.push('Display sleep blocker follows playing/paused state')
  await app.evaluate(
    ({ app }, paths) => app.emit('second-instance', {}, paths, process.cwd()),
    [midi]
  )
  await page.waitForFunction((path) => window.__jap.usePlayer.getState().track?.path === path, midi)
  assert.ok(
    await page.evaluate(() =>
      window.__jap.useLibrary.getState().lists.some((l) => l.name === '保留测试歌单')
    )
  )
  await app.evaluate(
    ({ app }, uri) => app.emit('open-file', { preventDefault() {} }, uri),
    pathToFileURL(wav).href
  )
  await page.waitForFunction((path) => window.__jap.usePlayer.getState().track?.path === path, wav)
  checks.push('Warm launches / Finder event / file URL open without replacing saved lists')
  await page.screenshot({ path: path.join(out, 'touch-stage.png') })
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify({ status: 'passed', info, checks }, null, 2)
  )
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2))
} finally {
  await page
    .evaluate(() => window.__jap?.useSettings.getState().update({ keepScreenAwake: false }))
    .catch(() => {})
  await app.close()
}
