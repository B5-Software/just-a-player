// Real HWND geometry and compact-player regression; never opens an audio device.
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

const appDir = resolve(fileURLToPath(import.meta.url), '../..')
const out = join(tmpdir(), 'jap-desktop-qa')
mkdirSync(out, { recursive: true })
const wav = join(out, '小窗播放测试.wav')
const rate = 48000,
  data = Buffer.alloc(rate * 40 * 4),
  header = Buffer.alloc(44)
header.write('RIFF')
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(2, 22)
header.writeUInt32LE(rate, 24)
header.writeUInt32LE(rate * 4, 28)
header.writeUInt16LE(4, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(data.length, 40)
writeFileSync(wav, Buffer.concat([header, data]))
const geometryScript = join(out, 'geometry.ps1')
writeFileSync(
  geometryScript,
  `param([long]$Handle)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DesktopGeometry {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Info { public int Size; public Rect Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfoW(IntPtr h, ref Info info);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
$old = [DesktopGeometry]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$hwnd = [IntPtr]::new($Handle)
$rect = New-Object DesktopGeometry+Rect
$client = New-Object DesktopGeometry+Rect
$point = New-Object DesktopGeometry+Point
$info = New-Object DesktopGeometry+Info
$info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
$null = [DesktopGeometry]::GetWindowRect($hwnd, [ref]$rect)
$null = [DesktopGeometry]::GetClientRect($hwnd, [ref]$client)
$null = [DesktopGeometry]::ClientToScreen($hwnd, [ref]$point)
$null = [DesktopGeometry]::GetMonitorInfoW([DesktopGeometry]::MonitorFromWindow($hwnd, 2), [ref]$info)
$virtual = @{ Left=[DesktopGeometry]::GetSystemMetrics(76); Top=[DesktopGeometry]::GetSystemMetrics(77); Right=([DesktopGeometry]::GetSystemMetrics(76)+[DesktopGeometry]::GetSystemMetrics(78)); Bottom=([DesktopGeometry]::GetSystemMetrics(77)+[DesktopGeometry]::GetSystemMetrics(79)) }
@{ rect=$rect; client=$client; origin=$point; monitor=$info.Monitor; virtual=$virtual; parent=[DesktopGeometry]::GetParent($hwnd).ToInt64(); style=[DesktopGeometry]::GetWindowLongPtrW($hwnd,-16).ToInt64() } | ConvertTo-Json -Compress
$null = [DesktopGeometry]::SetThreadDpiAwarenessContext($old)
`
)

const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  cwd: appDir,
  env: { ...process.env, JAP_E2E: 'desktop' }
})
const page = await app.firstWindow(),
  checks = {},
  errors = []
page.on('pageerror', (e) => errors.push(e.message))
const assert = (v, message) => {
  if (!v) throw new Error(message)
}
const nativeGeometry = async (surface = 'main') => {
  const handle = await app.evaluate(
    ({ BrowserWindow }, surface) =>
      BrowserWindow.getAllWindows()
        .find((w) =>
          surface === 'main'
            ? !w.webContents.getURL().includes('surface=')
            : w.webContents.getURL().includes('surface=' + surface)
        )
        .getNativeWindowHandle()
        .readBigInt64LE()
        .toString(),
    surface
  )
  return JSON.parse(
    execFileSync('powershell.exe', ['-NoProfile', '-File', geometryScript, '-Handle', handle], {
      windowsHide: true,
      encoding: 'utf8'
    }).trim()
  )
}
try {
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  await page.evaluate((path) => {
    const j = window.__jap
    j.useSettings
      .getState()
      .update({ autoScan: false, wallpaperEnabled: false, argbEnabled: false, renderFps: 30 })
    j.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
    j.usePlayer.getState().play(path)
    j.useViz.getState().setAuto(false)
    j.useViz.getState().setScene('spectrum')
  }, wav)
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'playing')
  const identity = await app.evaluate(({ BrowserWindow }) => ({
    id: BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('surface='))
      .webContents.id,
    bounds: BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().includes('surface='))
      .getBounds()
  }))
  await page.getByRole('button', { name: '悬浮播放', exact: true }).click()
  await page.locator('[data-mini-player]').waitFor()
  checks.mini = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => !w.webContents.getURL().includes('surface=')
    )
    return {
      bounds: w.getBounds(),
      top: w.isAlwaysOnTop(),
      resizable: w.isResizable(),
      windows: BrowserWindow.getAllWindows().length,
      id: w.webContents.id
    }
  })
  // Windows rounds outer bounds at fractional DPI (up to a couple of DIPs).
  assert(
    checks.mini.bounds.width <= 444 && checks.mini.bounds.height <= 210,
    'Floating playback did not fold into a compact window'
  )
  assert(
    checks.mini.top && checks.mini.windows === 1 && checks.mini.id === identity.id,
    'Floating playback did not reuse the original window'
  )
  assert(await page.getByRole('slider', { name: '应用内音量' }).isVisible(), 'Mini volume missing')
  const seekBefore = Number(
    await page.getByRole('slider', { name: '播放进度' }).getAttribute('aria-valuenow')
  )
  await page.waitForTimeout(200)
  const draw = await page.evaluate(() => window.__japViz.lastDraw)
  await page.waitForTimeout(500)
  assert(
    (await page.evaluate(() => window.__japViz.lastDraw)) === draw,
    'Mini player still renders the hidden GPU stage'
  )
  assert(
    Number(await page.getByRole('slider', { name: '播放进度' }).getAttribute('aria-valuenow')) >
      seekBefore + 200,
    'Mini progress stopped updating'
  )
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'paused')
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'playing')
  await page.screenshot({ path: join(out, 'mini.png') })
  await page.getByRole('button', { name: '展开播放器' }).click()
  await page.locator('[data-mini-player]').waitFor({ state: 'detached' })
  assert(
    JSON.stringify(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => !w.webContents.getURL().includes('surface='))
          .getBounds()
      )
    ) === JSON.stringify(identity.bounds),
    'Expanding lost the original window bounds'
  )
  checks.miniControls = true

  const wallCreated = app.waitForEvent('window')
  checks.wallpaperMode = await page.evaluate(() => window.jap.setWindowMode('wallpaper'))
  assert(checks.wallpaperMode === 'wallpaper', checks.wallpaperMode)
  const wall = await wallCreated
  await wall.waitForFunction(
    () => window.__japViz && document.documentElement.dataset.renderSuspended !== '1'
  )
  checks.geometry = await nativeGeometry('wallpaper')
  const { rect, client, origin, virtual: monitor, parent, style } = checks.geometry
  assert(parent !== 0 && (style & 0x40000000) !== 0, 'Wallpaper is not a desktop child window')
  assert((style & 0x00cf0000) === 0, 'Wallpaper still has caption or resize frame')
  assert(
    ['Left', 'Top', 'Right', 'Bottom'].every((key) => rect[key] === monitor[key]),
    `Wallpaper does not cover the entire monitor: ${JSON.stringify(checks.geometry)}`
  )
  assert(
    client.Right === monitor.Right - monitor.Left &&
      client.Bottom === monitor.Bottom - monitor.Top &&
      origin.X === monitor.Left &&
      origin.Y === monitor.Top,
    `Wallpaper viewport has borders or offsets: ${JSON.stringify(checks.geometry)}`
  )
  const before = await wall.evaluate(() => window.__japViz.lastDraw)
  await page.waitForTimeout(300)
  assert(
    (await wall.evaluate(() => window.__japViz.lastDraw)) > before,
    'Desktop wallpaper is not drawing'
  )
  assert(
    (await wall.locator('[data-player-topbar], [data-player-dock], [data-mini-player]').count()) ===
      0,
    'Wallpaper contains player controls'
  )
  await wall.screenshot({ path: join(out, 'wallpaper.png') })
  await app.evaluate(({ screen }) =>
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), [
      'bounds',
      'scaleFactor'
    ])
  )
  await page.waitForTimeout(200)
  checks.afterMetrics = await nativeGeometry('wallpaper')
  assert(
    ['Left', 'Top', 'Right', 'Bottom'].every(
      (key) => checks.afterMetrics.rect[key] === monitor[key]
    ),
    'Display update broke fullscreen wallpaper'
  )
  await page.evaluate(() => window.jap.setWindowMode('mini'))
  await page.locator('[data-mini-player]').waitFor()
  assert((await nativeGeometry()).parent === 0, 'Mini remained attached to desktop')
  await page.getByRole('button', { name: '展开播放器' }).click()
  await page.locator('[data-mini-player]').waitFor({ state: 'detached' })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().includes('surface='))
      .maximize()
  )
  await page.waitForTimeout(200)
  await page.evaluate(() => window.jap.setWindowMode('mini'))
  await page.locator('[data-mini-player]').waitFor()
  await page.getByRole('button', { name: '展开播放器' }).click()
  assert(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.webContents.getURL().includes('surface='))
        .isMaximized()
    ),
    'Expanding lost maximized state'
  )
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => !w.webContents.getURL().includes('surface=')
    )
    w.unmaximize()
    w.setFullScreen(true)
  })
  await page.waitForTimeout(200)
  await page.evaluate(() => window.jap.setWindowMode('mini'))
  await page.locator('[data-mini-player]').waitFor()
  assert(
    await app.evaluate(
      ({ BrowserWindow }) =>
        !BrowserWindow.getAllWindows()
          .find((w) => !w.webContents.getURL().includes('surface='))
          .isFullScreen()
    ),
    'Mini remained fullscreen'
  )
  await page.getByRole('button', { name: '展开播放器' }).click()
  assert(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.webContents.getURL().includes('surface='))
        .isFullScreen()
    ),
    'Expanding lost fullscreen state'
  )
  await page.evaluate(() => window.__jap.useSettings.getState().update({ wallpaperEnabled: false }))
  await page.waitForTimeout(200)
  assert(
    await app.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows().length === 1 &&
        BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('surface='))
          .webContents.id === id,
      identity.id
    ),
    'Mode transitions created a second renderer'
  )
  checks.restoration = true
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
