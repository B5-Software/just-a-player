// Disable WebGL deliberately: GPU failure must not remove the shell or audio controls.
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { graphicsArgs } from './e2e-graphics.mjs'
const cwd = resolve(fileURLToPath(import.meta.url), '../..'),
  out = join(tmpdir(), 'jap-fallback-qa')
mkdirSync(out, { recursive: true })
const rate = 48000,
  pcm = Buffer.alloc(rate * 20 * 4),
  header = Buffer.alloc(44)
header.write('RIFF')
header.writeUInt32LE(36 + pcm.length, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(2, 22)
header.writeUInt32LE(rate, 24)
header.writeUInt32LE(rate * 4, 28)
header.writeUInt16LE(4, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(pcm.length, 40)
const path = join(out, 'fallback.wav')
writeFileSync(path, Buffer.concat([header, pcm]))
const app = await electron.launch({
  executablePath: electronPath,
  cwd,
  args: ['.', '--no-sandbox', ...graphicsArgs],
  env: { ...process.env, JAP_E2E: 'fallback' }
})
try {
  await app.context().addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null
      return original.call(this, type, ...args)
    }
  })
  const page = await app.firstWindow()
  await page.reload()
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  await page.locator('[data-graphics-fallback]').waitFor()
  await page.locator('[data-player-dock]').waitFor()
  await page.evaluate(() => {
    const j = window.__jap
    j.useUi.getState().setOnboardingOpen(false)
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
  })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByText('记住播放列表', { exact: true }).waitFor()
  await page.evaluate((path) => {
    window.__jap.useUi.getState().closePanel()
    window.__jap.usePlayer.getState().play(path)
  }, path)
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'playing')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'paused')
  await page.screenshot({ path: join(out, 'fallback.png') })
  if (process.platform === 'win32') {
    const next = app.waitForEvent('window')
    await page.evaluate(() =>
      window.__jap.useSettings.getState().update({ wallpaperEnabled: true })
    )
    const wallpaper = await next
    await wallpaper.locator('[data-wallpaper-fallback]').waitFor()
    await wallpaper.locator('[data-wallpaper-display]').first().waitFor()
    await page.evaluate(() =>
      window.__jap.useSettings.getState().update({ wallpaperEnabled: false })
    )
  }
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        'GPU failure retains shell',
        'settings stay usable',
        'native audio plays and pauses',
        'wallpaper fallback on Windows'
      ]
    })
  )
} finally {
  await app.close()
}
