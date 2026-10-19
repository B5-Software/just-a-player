// Real engine + disk + restart regression for two independent shuffled playlists.
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
const cwd = resolve(fileURLToPath(import.meta.url), '../..')
const profile = join(tmpdir(), 'jap-e2e-userdata'),
  media = join(tmpdir(), 'jap-memory-qa')
mkdirSync(profile, { recursive: true })
mkdirSync(media, { recursive: true })
const paths = ['settings.json', 'playlists.json'].map((name) => join(profile, name))
const backups = paths.map((path) => (existsSync(path) ? readFileSync(path) : null))
writeFileSync(
  paths[0],
  JSON.stringify({
    onboardingComplete: true,
    autoScan: false,
    rememberPlaylist: true,
    wallpaperEnabled: false,
    argbEnabled: false,
    renderFps: 24
  })
)
const rate = 48000,
  data = Buffer.alloc(rate * 35 * 4),
  header = Buffer.alloc(44)
for (let i = 0; i < data.length / 4; i++) {
  const sample = Math.round(Math.sin((i / rate) * 440 * Math.PI * 2) * 300)
  data.writeInt16LE(sample, i * 4)
  data.writeInt16LE(sample, i * 4 + 2)
}
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
const tracks = ['one', 'two', 'three'].map((name) => {
  const path = join(media, name + '.wav')
  writeFileSync(path, Buffer.concat([header, data]))
  return path
})
let app, page
const assert = (v, message) => {
  if (!v) throw new Error(message)
}
async function launch() {
  app = await electron.launch({
    executablePath: electronPath,
    cwd,
    args: [
      '.',
      '--no-sandbox',
      ...(process.platform === 'darwin'
        ? []
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    ],
    env: { ...process.env, JAP_E2E: 'memory' }
  })
  page = await app.firstWindow()
  await page.waitForFunction(
    () => window.__jap?.usePlayer.getState().connected && window.__jap.useLibrary.getState().loaded
  )
  await page.evaluate(() =>
    window.__jap.usePlayer.getState().setOutput({ api: 'null', dsdMode: 'pcm' })
  )
}
async function playAt(list, item, position) {
  await page.evaluate(({ list, item }) => window.__jap.playItem(list, item), { list, item })
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'playing')
  await page.evaluate((position) => window.__jap.usePlayer.getState().seek(position), position)
  await page.waitForFunction(
    (position) => window.__jap.usePlayer.getState().position.ms >= position - 200,
    position
  )
  await page.evaluate(() => window.__jap.usePlayer.getState().togglePause())
  await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'paused')
}
try {
  await launch()
  const ids = await page.evaluate((tracks) => {
    const l = window.__jap.useLibrary.getState(),
      a = l.createList('Morning'),
      ai = l.addPaths(a, tracks),
      b = l.createList('Night'),
      bi = l.addPaths(b, tracks)
    l.setShuffle(true)
    return { a, ai, b, bi }
  }, tracks)
  await playAt(ids.a, ids.ai[1], 7000)
  await playAt(ids.b, ids.bi[2], 11000)
  const before = await page.evaluate(() => window.__jap.useLibrary.getState().memories)
  assert(
    before[ids.a].itemId === ids.ai[1] && before[ids.a].positionMs >= 6800,
    'First list lost its own position: ' + JSON.stringify({ ids, before })
  )
  assert(
    before[ids.b].itemId === ids.bi[2] && before[ids.b].positionMs >= 10800,
    'Second list position missing: ' + JSON.stringify({ ids, before })
  )
  await app.close()
  app = null
  await launch()
  assert(
    await page.evaluate(() => window.__jap.usePlayer.getState().state === 'stopped'),
    'Restart unexpectedly autoplays'
  )
  for (const [id, position] of [
    [ids.b, 10800],
    [ids.a, 6800]
  ]) {
    await page.evaluate((id) => window.__jap.useLibrary.getState().setActive(id), id)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await page.waitForFunction(
      (position) =>
        window.__jap.usePlayer.getState().state === 'playing' &&
        window.__jap.usePlayer.getState().position.ms >= position,
      position
    )
    const order = await page.evaluate(() => window.__jap.useLibrary.getState().playback.order)
    assert(
      JSON.stringify(order) === JSON.stringify(before[id].order),
      'Shuffle order changed on resume'
    )
    await page.evaluate(() => window.__jap.usePlayer.getState().stop())
    await page.waitForFunction(() => window.__jap.usePlayer.getState().state === 'stopped')
  }
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        'separate track and position',
        'shuffle order across restart',
        'no autoplay',
        'switch lists and resume'
      ]
    })
  )
} finally {
  if (app) await app.close()
  for (let i = 0; i < paths.length; i++) {
    if (backups[i]) writeFileSync(paths[i], backups[i])
    else if (existsSync(paths[i])) unlinkSync(paths[i])
  }
}
