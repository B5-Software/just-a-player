import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { graphicsArgs } from './e2e-graphics.mjs'
import { flacLyrics, WORD_LYRICS } from '../../../scripts/fixtures/pcm.mjs'
const cwd = fileURLToPath(new URL('..', import.meta.url)),
  out = path.join(cwd, 'test-results/lyrics')
fs.mkdirSync(out, { recursive: true })
const fixture = path.join(os.tmpdir(), 'jap-embedded-qa.flac')
fs.writeFileSync(
  fixture,
  flacLyrics(fs.readFileSync(new URL('../../../scripts/fixtures/pcm24-768.flac', import.meta.url)))
)
const app = await electron.launch({
  executablePath: electronPath,
  cwd,
  args: ['.', ...graphicsArgs],
  env: { ...process.env, JAP_E2E: 'lyrics' },
})
const errors = [],
  checks = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && /THREE.WebGLProgram|shader error/i.test(m.text()))
      errors.push(m.text())
  })
  await page.waitForFunction(() => !!window.__jap?.usePlayer.getState().connected)
  assert.equal(
    (
      await page.evaluate(
        (path) => window.__jap.engine.query({ type: 'embeddedLyrics', path }),
        fixture
      )
    ).text,
    WORD_LYRICS
  )
  checks.push('Embedded FLAC LYRICS preserves all square word timestamps')
  await page.evaluate((text) => {
    const j = window.__jap
    j.useUi.getState().setOnboardingOpen(false)
    j.useSettings
      .getState()
      .update({
        autoScan: false,
        autoHideControls: false,
        lyricsVisible: true,
        lyricsMode: '3d',
        lyricsPosition: 'center',
        lyricsFont: 'sans',
        lyricsSize: 100,
        lyricsOffset: { x: 0, y: 0, z: 0 },
      })
    j.useLyrics.setState({ path: null, text, source: 'embedded' })
    j.usePlayer.setState({ state: 'paused', position: { ms: 1250, at: performance.now() } })
  }, WORD_LYRICS)
  await page.waitForFunction(
    () => window.__japLyrics?.ready && window.__japLyrics.lines[0]?.o?.words.length === 6
  )
  const progress = await page.evaluate(() => {
    const r = window.__japLyrics,
      first = r.lines[0].o
    r.renderOffline(0.1, 1, 960, 540)
    const start = first.cut.value
    r.renderOffline(1.25, 1, 960, 540)
    const middle = first.cut.value
    r.renderOffline(2.9, 1, 960, 540)
    const end = first.cut.value
    return {
      start,
      middle,
      end,
      words: first.words,
      karaoke: first.karaoke.value,
      programs: r.renderer.info.programs.length,
    }
  })
  assert.ok(progress.start < progress.middle && progress.middle < progress.end)
  assert.equal(progress.karaoke, 1)
  assert.ok(progress.programs > 0)
  assert.ok(Math.abs(progress.middle - (progress.words[2].x0 + progress.words[2].x1) / 2) < 1e-6)
  await page.screenshot({ path: path.join(out, '3d.png') })
  checks.push('3D extruded lyric shader compiles and advances continuously inside the current word')
  await page.evaluate(() => window.__jap.useSettings.getState().update({ lyricsMode: '2d' }))
  await page.waitForFunction(() => document.querySelectorAll('[data-lyric-word]').length === 6)
  const spans = await page
    .locator('[data-lyric-word]')
    .evaluateAll((els) =>
      els.map((e) => ({
        text: e.textContent,
        background: getComputedStyle(e).backgroundImage,
        shadow: getComputedStyle(e).textShadow,
      }))
    )
  assert.deepEqual(
    spans.map((s) => s.text),
    ['测', '试', '逐', '字', '歌', '词']
  )
  assert.match(spans[2].background, /50%/)
  assert.match(spans[3].background, /0%/)
  assert.equal(spans[2].shadow, 'none')
  await page.screenshot({ path: path.join(out, '2d.png') })
  checks.push(
    '2D karaoke highlights the same half-word at 1.25s without black shadow covering its fill'
  )
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ checks }, null, 2))
  console.log(JSON.stringify({ checks }, null, 2))
} finally {
  await app.close()
}
