// Portable CI smoke: native engine + renderer, never opens an audio device.
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { resolve, join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const cwd = resolve(fileURLToPath(import.meta.url), '../..')
const packaged = process.argv.includes('--packaged')
const folder =
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
const executablePath = packaged ? join(cwd, 'release', folder, binary) : electronPath
if (!existsSync(executablePath)) throw new Error('Missing executable: ' + executablePath)
const app = await electron.launch({
  executablePath,
  cwd,
  args: [
    ...(packaged ? [] : ['.']),
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? []
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
  ],
  env: { ...process.env, JAP_E2E: 'smoke' }
})
let page
const errors = [],
  logs = []
app.process().stderr?.on('data', (data) => {
  logs.push(String(data))
  if (logs.length > 80) logs.shift()
})
try {
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  const info = await page.evaluate(async () => {
    const j = window.__jap
    j.useSettings
      .getState()
      .update({ autoScan: false, wallpaperEnabled: false, argbEnabled: false })
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
    j.useUi.getState().setOnboardingOpen(true)
    const version = window.jap.version,
      platform = window.jap.platform
    return { version, platform, output: j.usePlayer.getState().output.api }
  })
  if (info.version !== '0.1.0' || info.output !== 'null') throw new Error(JSON.stringify(info))
  await page.waitForFunction(
    () => window.__japLyrics?.preview && window.__japLyrics.lines.length > 0
  )
  if (await page.evaluate(() => window.__jap.useUi.getState().lyricsAdjusting))
    throw new Error('First onboarding step must only drag visualization')
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(JSON.stringify({ ok: true, architecture: process.arch, packaged, ...info }))
} catch (error) {
  const output = join(cwd, 'test-results')
  mkdirSync(output, { recursive: true })
  const state = await page
    ?.evaluate(() => ({
      url: location.href,
      body: document.body.innerText.slice(0, 2500),
      dataset: { ...document.documentElement.dataset },
      ui: window.__jap?.useUi.getState(),
      lyrics: window.__japLyrics
        ? { preview: window.__japLyrics.preview, lines: window.__japLyrics.lines.length }
        : null
    }))
    .catch(() => null)
  const diagnostic = { error: String(error), errors, state, logs }
  console.error(JSON.stringify(diagnostic, null, 2))
  writeFileSync(join(output, 'smoke.json'), JSON.stringify(diagnostic, null, 2))
  await page?.screenshot({ path: join(output, 'smoke.png') }).catch(() => {})
  throw error
} finally {
  await app.close()
}
