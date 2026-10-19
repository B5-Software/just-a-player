// Portable CI smoke: native engine + renderer, never opens an audio device.
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
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
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader'
  ],
  env: { ...process.env, JAP_E2E: 'smoke' }
})
try {
  const page = await app.firstWindow(),
    errors = []
  page.on('pageerror', (e) => errors.push(e.message))
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
  console.log(JSON.stringify({ ok: true, ...info }))
} finally {
  await app.close()
}
