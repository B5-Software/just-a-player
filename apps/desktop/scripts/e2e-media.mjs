// Exercise the shipped CLI + shared libraries without any system FFmpeg on PATH.
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { graphicsArgs } from './e2e-graphics.mjs'
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
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      ![
        'path',
        'jap_ffmpeg_path',
        'jap_ffprobe_path',
        'ld_library_path',
        'dyld_library_path'
      ].includes(name.toLowerCase())
  )
)
env.PATH = join(tmpdir(), 'jap-no-system-tools')
env.JAP_E2E = 'media'
const app = await electron.launch({
  executablePath: packaged ? join(cwd, 'release', folder, binary) : electronPath,
  cwd,
  args: [...(packaged ? [] : ['.']), '--no-sandbox', ...graphicsArgs],
  env
})
const report = { packaged, platform: process.platform, architecture: process.arch, exports: [] }
let page
try {
  const paths = await app.evaluate(({ app }) => ({
    ffmpeg: process.env.JAP_FFMPEG_PATH,
    ffprobe: process.env.JAP_FFPROBE_PATH,
    expected: app.isPackaged ? process.resourcesPath : app.getAppPath()
  }))
  assert.ok(paths.ffmpeg?.startsWith(paths.expected))
  assert.ok(paths.ffprobe?.startsWith(paths.expected))
  assert.ok(paths.ffmpeg.includes('media-tools'))
  const tools = dirname(dirname(paths.ffmpeg))
  const bundle = JSON.parse(readFileSync(join(tools, 'bundle.json'), 'utf8'))
  assert.equal(bundle.target, `${process.platform}-${process.arch}`)
  assert.ok(existsSync(join(tools, 'licenses/ffmpeg/COPYING.GPLv2')))
  assert.ok(existsSync(join(tools, 'SOURCE.md')))
  report.helperArchitecture = bundle.binaryArch
  const execute = (name, args) =>
    execFileSync(paths[name], args, {
      env,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024
    })
  report.version = execute('ffmpeg', ['-version']).split('\n')[0]
  assert.ok(report.version.includes('9.0.2-tas'))
  const encoders = execute('ffmpeg', ['-hide_banner', '-encoders'])
  for (const name of ['libx264', 'libopus', 'aac', 'flac', 'pcm_s32le'])
    assert.ok(encoders.includes(name), name)
  const decoders = execute('ffmpeg', ['-hide_banner', '-decoders'])
  for (const name of ['ape', 'dca']) assert.ok(decoders.includes(name), name)
  const out = join(
    tmpdir(),
    `jap-media-${process.platform}-${process.arch}-${packaged ? 'packaged' : 'source'}`
  )
  mkdirSync(out, { recursive: true })
  const wav = join(out, '内置工具 音源.wav'),
    dts = join(out, '内置工具 DTS.dts')
  execute('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4:sample_rate=48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s24le',
    wav
  ])
  execute('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'dca', '-strict', '-2', dts])
  page = await app.firstWindow()
  await page.waitForFunction(() => window.__jap?.usePlayer.getState().connected)
  await page.evaluate(() => {
    window.__jap.useSettings
      .getState()
      .update({ autoScan: false, wallpaperEnabled: false, argbEnabled: false })
    window.__jap.useUi.getState().setOnboardingOpen(false)
    window.__jap.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
  })
  const track = await page.evaluate((path) => window.__jap.usePlayer.getState().probe(path), dts)
  assert.ok(track?.codec.includes('DTS') && track.codec.includes('FFmpeg'), JSON.stringify(track))
  await page.evaluate((path) => window.__jap.usePlayer.getState().play(path), dts)
  await page.waitForFunction(
    () =>
      window.__jap.usePlayer.getState().state === 'playing' &&
      window.__jap.usePlayer.getState().position.ms > 250
  )
  await page.evaluate(() => window.__jap.usePlayer.getState().togglePause())
  report.nativeDtsPlayback = true
  // Real video IPC pipeline, independent of GPU availability (Intel VM has no GPU).
  for (const audio of ['aac', 'opus', 'flac', 'pcm', 'copy']) {
    const output = join(out, `export-${audio}.${audio === 'aac' ? 'mp4' : 'mkv'}`)
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, output)
    await page.evaluate(
      async ({ audio, wav }) => {
        const job = await window.jap.videoStart({
          width: 320,
          height: 180,
          fps: 24,
          quality: 28,
          encoder: 'cpu',
          title: 'Bundled codec test',
          intro: 0,
          outro: 0,
          duration: 0.5,
          musicDuration: 0.5,
          path: wav,
          audio,
          audioBits: 24
        })
        if (!job?.id) throw new Error('Video IPC did not start')
        const pixels = new Uint8Array(320 * 180 * 4)
        for (let p = 0; p < pixels.length; p += 4) {
          pixels[p] = 96
          pixels[p + 1] = 72
          pixels[p + 2] = 180
          pixels[p + 3] = 255
        }
        for (let frame = 0; frame < 12; frame++) await window.jap.videoFrame(job.id, pixels)
        await window.jap.videoFinish(job.id, wav)
      },
      { audio, wav }
    )
    const probe = JSON.parse(
      execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])
    )
    assert.ok(
      probe.streams.some((s) => s.codec_name === 'h264' && s.width === 320 && s.height === 180)
    )
    const expected = {
      aac: 'aac',
      opus: 'opus',
      flac: 'flac',
      pcm: 'pcm_s32le',
      copy: 'pcm_s24le'
    }[audio]
    assert.ok(
      probe.streams.some((s) => s.codec_name === expected),
      `${audio}: ${JSON.stringify(probe.streams)}`
    )
    assert.ok(Math.abs(Number(probe.format.duration) - 0.5) < 0.15)
    execute('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-'])
    report.exports.push(audio)
  }
  report.ok = true
  console.log(JSON.stringify(report))
} catch (error) {
  report.error = String(error)
  throw error
} finally {
  const results = join(cwd, 'test-results')
  mkdirSync(results, { recursive: true })
  writeFileSync(
    join(results, `media-${packaged ? 'packaged' : 'source'}.json`),
    JSON.stringify(report, null, 2)
  )
  await app.close()
}
