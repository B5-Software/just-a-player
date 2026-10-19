// 端到端冒烟：启动真实的 Electron 应用，播放带封面与歌词的合成曲目，检查取色、歌词、面板与全屏，并截图。
// 用法：pnpm build && node scripts/e2e-shoot.mjs [输出目录]
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

const appDir = resolve(fileURLToPath(import.meta.url), '../..')
const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'jap-e2e'))
mkdirSync(outDir, { recursive: true })

const album = join(outDir, 'album')
mkdirSync(album, { recursive: true })

/** 双声道 16 位 PCM 的正弦和弦，足够验证解码与播放进度。 */
function makeWav(file, seconds, root) {
  const sr = 44100
  const n = sr * seconds
  const pcm = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const v =
      0.25 * Math.sin(2 * Math.PI * root * t) +
      0.12 * Math.sin(2 * Math.PI * root * 1.25 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t))
    const s = Math.round(v * 32767)
    pcm.writeInt16LE(s, i * 4)
    pcm.writeInt16LE(s, i * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(sr, 24)
  header.writeUInt32LE(sr * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  writeFileSync(file, Buffer.concat([header, pcm]))
}

const LRC = [
  '[ti:Demo Drift]',
  '[00:00.00]夜色把城市调成低音',
  '[00:00.00]The night tunes the city down low',
  '[00:04.00]霓虹在雨里慢慢融化',
  '[00:04.00]Neon melts slowly in the rain',
  '[00:08.00]我们沿着光的方向漂流',
  '[00:12.50]没有地图 也没有终点',
  '[00:17.00]每一个字都有了厚度',
  '[00:21.50]向前一步 就是下一句'
].join('\n')

makeWav(join(album, 'demo.wav'), 60, 220)
makeWav(join(album, 'second.wav'), 8, 330)
writeFileSync(join(album, 'demo.lrc'), LRC)
const cover = 'C:\\Windows\\Web\\Wallpaper\\Windows\\img0.jpg'
const hasCover = existsSync(cover)
if (hasCover) copyFileSync(cover, join(album, 'cover.jpg'))

// 播放列表与设置会持久化，每次都从干净的数据目录开始，结果才可重复
rmSync(join(tmpdir(), 'jap-e2e-userdata'), { recursive: true, force: true })

const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  cwd: appDir,
  env: { ...process.env, JAP_E2E: '1' }
})
const win = await app.firstWindow()
const problems = []
win.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
win.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`)
})
app.process().stderr?.on('data', (d) => problems.push(`stderr: ${String(d).trim()}`))

const shot = (name) => win.screenshot({ path: join(outDir, `${name}.png`) })

await win.waitForFunction(() => window.__jap && window.__jap.usePlayer.getState().connected, null, {
  timeout: 20000
})
await win.evaluate(async (dir) => {
  const jap = window.__jap
  jap.useViz.getState().setAuto(false)
  jap.usePlayer.getState().setVolume(1)
  jap.usePlayer.getState().setOutput({ api: 'null' })
  await jap.addAudioPaths([dir], true)
}, album)
await win.waitForTimeout(3500)

const snapshot = await win.evaluate(() => {
  const jap = window.__jap
  const lib = jap.useLibrary.getState()
  const list = lib.lists.find((l) => l.id === lib.activeListId)
  const cover = jap.useCover.getState()
  return {
    state: jap.usePlayer.getState().state,
    title: jap.usePlayer.getState().track?.title ?? null,
    items: list.items.length,
    artPresent: cover.art !== null,
    palette: cover.palette,
    lyricsLines: jap.useLyrics.getState().text?.split('\n').length ?? 0,
    lyricsSource: jap.useLyrics.getState().source,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    shuffle: lib.shuffle,
    repeat: lib.repeat
  }
})
console.log('snapshot:', JSON.stringify(snapshot))
if (snapshot.state !== 'playing') problems.push(`没有开始播放（状态 ${snapshot.state}）`)
if (snapshot.items !== 2) problems.push(`递归添加应得到 2 首，实际 ${snapshot.items}`)
if (snapshot.lyricsSource !== 'sidecar') problems.push(`同名 .lrc 没有自动加载（来源 ${snapshot.lyricsSource}）`)
if (hasCover) {
  if (!snapshot.artPresent) problems.push('同目录封面没有加载')
  if (!snapshot.palette) problems.push('封面没有取出颜色')
  if (snapshot.accent === '132 118 255') problems.push('自动取色没有生效（强调色仍是默认值）')
}

await shot('stage')

await win.evaluate(() => window.__jap.useSettings.getState().update({ lyricsPosition: 'right' }))
await win.waitForTimeout(2200)
await shot('lyrics-right-topcw')
await win.evaluate(() => window.__jap.useSettings.getState().update({ lyricsPosition: 'center' }))
await win.waitForTimeout(2200)
await shot('lyrics-center-none')
await win.evaluate(() => window.__jap.useSettings.getState().update({ lyricsPosition: 'left' }))
await win.waitForTimeout(2200)
await shot('lyrics-left-topccw')
await win.evaluate(() => window.__jap.useSettings.getState().update({ lyricsPosition: 'bottom' }))
await win.waitForTimeout(2200)
await shot('lyrics-bottom-tilt')
await win.evaluate(() =>
  window.__jap.useSettings.getState().update({ lyricsPosition: 'center', lyricsPose: 'sphere' })
)
await win.waitForTimeout(2200)
await shot('lyrics-sphere')
await win.evaluate(() =>
  window.__jap.useSettings
    .getState()
    .update({ lyricsPose: 'free', lyricsRotation: { x: -35, y: 25, z: 15 } })
)
await win.waitForTimeout(2200)
await shot('lyrics-free-xyz')
await win.evaluate(() => window.__jap.useSettings.getState().update({ lyricsPose: 'auto' }))

// 下一首：真的点击按钮，验证切歌与封面/歌词随之变化
await win.getByRole('button', { name: '下一首' }).click()
await win.waitForTimeout(1800)
const nextPath = await win.evaluate(() => window.__jap.usePlayer.getState().track?.path ?? '')
if (!nextPath.endsWith('second.wav')) {
  problems.push(`点击下一首后没有切到第二首（当前 ${nextPath}）`)
}

for (const panel of ['播放列表', '歌词', '外观', '设置', '信号链', '输出']) {
  await win.getByRole('button', { name: panel, exact: true }).click()
  await win.waitForTimeout(600)
  const open = await win.getByRole('heading', { name: panel, exact: true }).count()
  if (open === 0) problems.push(`面板「${panel}」没有打开`)
  await shot(`panel-${panel}`)
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
}

for (const id of ['terrain', 'plasma', 'city']) {
  await win.evaluate((scene) => window.__jap.useViz.getState().setScene(scene), id)
  await win.waitForTimeout(2200)
  await shot(`scene-${id}`)
}

// 全屏只是窗口全屏，布局不变；全屏时控件始终自动隐藏
await win.evaluate(() => window.__jap.useViz.getState().setFullscreen(true))
await win.waitForTimeout(800)
const fullscreenOn = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())
if (!fullscreenOn) problems.push('全屏按钮没有触发窗口级全屏')
await win.mouse.move(640, 400)
await win.waitForTimeout(4200)
await win.waitForFunction(()=>Number(getComputedStyle(document.querySelector('header')).opacity)<0.05,null,{timeout:8000})
const headerOpacity = await win.evaluate(() => getComputedStyle(document.querySelector('header')).opacity)
if (Number(headerOpacity) > 0.1) problems.push(`全屏时控件没有自动隐藏（透明度 ${headerOpacity}）`)
await shot('fullscreen-idle')
await win.mouse.move(640, 300)
await win.waitForTimeout(500)
await shot('fullscreen-awake')
await win.evaluate(() => window.__jap.useViz.getState().setFullscreen(false))
await win.waitForTimeout(900)
const restored = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())
if (restored) problems.push('退出全屏失败')

const state = await win.evaluate(() => {
  const s = window.__jap.usePlayer.getState()
  return { state: s.state, ms: s.position.ms, error: s.error }
})
console.log('player:', JSON.stringify(state))
console.log('screenshots ->', outDir)
if (problems.length) console.log('problems:\n' + [...new Set(problems)].join('\n'))
else console.log('problems: none')
const failed = problems.length > 0
await app.close()
// The engine's expected shutdown diagnostic is written to stderr on close.
process.exitCode = failed ? 1 : 0
