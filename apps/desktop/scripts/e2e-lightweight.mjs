import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wave } from '../../../scripts/fixtures/pcm.mjs'
import { graphicsArgs } from './e2e-graphics.mjs'
const cwd = fileURLToPath(new URL('..', import.meta.url))
const packaged = process.argv.includes('--packaged')
const executable = packaged
  ? join(
      cwd,
      'release',
      process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked',
      'Just A Player.exe'
    )
  : electronPath
const root = resolve(cwd, '../..'),
  data = join(cwd, 'test-results', `light-handoff-${Date.now()}`)
mkdirSync(data, { recursive: true })
const path = join(data, '交接测试.wav')
writeFileSync(path, wave({ seconds: 60 }))
const app = await electron.launch({
  executablePath: executable,
  cwd,
  args: [...(packaged ? [] : ['.']), ...graphicsArgs],
  env: { ...process.env, JAP_E2E: 'lightweight', JAP_E2E_USERDATA: data },
})
try {
  const page = await app.firstWindow()
  await page.waitForFunction(
    () =>
      window.__jap?.usePlayer.getState().connected &&
      window.__jap.useLibrary.getState().loaded
  )
  await page.evaluate(async (path) => {
    const j = window.__jap
    j.useUi.getState().setOnboardingOpen(false)
    j.useSettings
      .getState()
      .update({ autoScan: false, autoHideControls: false })
    j.usePlayer.getState().setOutput({ api: 'null' })
    j.usePlayer.getState().setVolume(0.17)
    await j.addAudioPaths([path])
    j.usePlayer.getState().play(path)
  }, path)
  await page.waitForFunction(
    () =>
      window.__jap.usePlayer.getState().state === 'playing' &&
      window.__jap.usePlayer.getState().position.ms > 600
  )
  await page.evaluate(() => window.__jap.useUi.setState({ panel: 'settings' }))
  const exited = new Promise((resolve) => app.process().once('exit', resolve))
  void page
    .getByRole('switch', { name: '轻量模式', exact: true })
    .click({ timeout: 10000, noWaitAfter: true })
    .catch(() => {})
  const until = async (predicate, label) => {
    const end = Date.now() + 40000
    let state
    while (Date.now() < end) {
      try {
        state = JSON.parse(
          readFileSync(join(data, 'native-report.json'), 'utf8')
        )
        if (predicate(state)) return state
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    throw Error(label + ': ' + JSON.stringify(state))
  }
  const input = async (value) => {
    writeFileSync(join(data, 'native-input.tmp'), JSON.stringify(value))
    renameSync(join(data, 'native-input.tmp'), join(data, 'native-input.json'))
    await new Promise((r) => setTimeout(r, 300))
  }
  const state = await until(
    (s) =>
      s.renderer === 'egui-native' && s.state === 'playing' && s.position > 500,
    'Native window'
  )
  assert.equal(state.webview, false)
  assert(Math.abs(state.volume - 0.17) < 1e-5)
  assert(state.library.lists.some((l) => l.items.some((i) => i.path === path)))
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('Electron did not exit')), 10000)
    ),
  ])
  assert.equal(
    JSON.parse(readFileSync(join(data, 'lightweight-mode.json'), 'utf8'))
      .enabled,
    true
  )
  await input({ type: 'command', command: 'pause' })
  await until((s) => s.state === 'paused', 'Pause native')
  await input({ type: 'volume', gain: 0.07 })
  await until((s) => Math.abs(s.volume - 0.07) < 1e-5, 'Change native volume')
  await input({ type: 'screenshot' })
  await new Promise((r) => setTimeout(r, 500))
  await input({ type: 'full' })
  await new Promise((r) => setTimeout(r, 1800))
  assert.equal(
    JSON.parse(readFileSync(join(data, 'lightweight-mode.json'), 'utf8'))
      .enabled,
    false
  )
  const saved = JSON.parse(readFileSync(join(data, 'lightweight.json'), 'utf8'))
  assert(saved.last.positionMs > 500)
  writeFileSync(
    join(data, 'passed.json'),
    JSON.stringify(
      {
        passed: true,
        renderer: state.renderer,
        webview: false,
        checks: [
          'Electron exits after native Rust window opens',
          'playing position, volume and session queue transferred',
          'native pause and gain',
          'full mode requested with saved state',
        ],
      },
      null,
      2
    )
  )
  console.log('Desktop native handoff passed: ' + data)
} catch (error) {
  console.error(error)
  throw error
} finally {
  if (app.process().exitCode === null) app.process().kill()
  // Only QA instances with this exact isolated user-data directory belong to us.
  if (process.platform === 'win32') {
    const { spawnSync } = await import('node:child_process')
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${data.replaceAll("'", "''")}*' -and ($_.Name -eq 'electron.exe' -or $_.Name -eq 'Just A Player.exe' -or $_.Name -eq 'jap-lightweight.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { windowsHide: true }
    )
  }
}
