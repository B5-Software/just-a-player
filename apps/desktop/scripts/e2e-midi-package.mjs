import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { graphicsArgs } from './e2e-graphics.mjs'
import { answerNextFileDialog } from './e2e-dialog-helper.mjs'
import { writeMidi } from '../../../scripts/fixtures/midi.mjs'
const cwd = fileURLToPath(new URL('..', import.meta.url)),
  out = path.join(cwd, 'test-results')
fs.mkdirSync(out, { recursive: true })
const dir =
  process.platform === 'win32'
    ? process.arch === 'arm64'
      ? 'win-arm64-unpacked'
      : 'win-unpacked'
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'mac-arm64'
        : 'mac'
      : process.arch === 'arm64'
        ? 'linux-arm64-unpacked'
        : 'linux-unpacked'
const binary =
  process.platform === 'win32'
    ? 'Just A Player.exe'
    : process.platform === 'darwin'
      ? 'Just A Player.app/Contents/MacOS/Just A Player'
      : 'just-a-player'
const midi = path.join(out, 'Package MIDI.mid')
writeMidi(midi)
const app = await electron.launch({
  executablePath: path.join(cwd, 'release', dir, binary),
  cwd,
  args: ['--no-sandbox', ...graphicsArgs],
  env: { ...process.env, JAP_E2E: 'midi-package' },
})
const checks = []
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  const bundled = await page.evaluate(() => window.jap.bundledMidi)
  assert.equal(bundled, process.env.JAP_BUNDLE_MIDI !== '0')
  await page.evaluate(() => {
    const j = window.__jap
    j.useUi.getState().setOnboardingOpen(false)
    j.usePlayer.getState().setOutput({ api: 'null' })
    j.useSettings.getState().update({ midiSoundfont: '', midiSampleRate: 96000 })
  })
  if (!bundled) {
    await page.evaluate((p) => window.__jap.usePlayer.getState().play(p), midi)
    await page.waitForFunction(() => window.__jap.usePlayer.getState().error?.includes('导入 SF2'))
    checks.push('without-midi contains no hidden bank and explains how to import SF2')
    await answerNextFileDialog(page, path.resolve(cwd, '../../scripts/fixtures/sine.sf2'))
    const imported = await page.evaluate(() => window.jap.importSoundfont())
    assert.ok(imported)
    await page.evaluate(
      (p) => window.__jap.useSettings.getState().update({ midiSoundfont: p }),
      imported
    )
    checks.push('Themed SF2 import works in the packaged application')
  }
  await page.evaluate((p) => window.__jap.usePlayer.getState().play(p), midi)
  await page.waitForFunction(
    () =>
      window.__jap.usePlayer.getState().state === 'playing' &&
      window.__jap.usePlayer.getState().track?.codec.startsWith('MIDI'),
    null,
    { timeout: 30000 }
  )
  const track = await page.evaluate(() => window.__jap.usePlayer.getState().track)
  assert.equal(track.format.sampleRate, 96000)
  assert.equal(track.format.float, true)
  if (bundled) assert.match(track.codec, /MuseScore_General_HQ/)
  checks.push('Packaged MIDI synthesizes 96 kHz Float32 audio through the native engine')
  fs.writeFileSync(
    path.join(out, 'midi-package.json'),
    JSON.stringify({ status: 'passed', bundled, track, checks }, null, 2)
  )
  console.log(JSON.stringify({ status: 'passed', bundled, checks }))
} finally {
  await app.close()
}
