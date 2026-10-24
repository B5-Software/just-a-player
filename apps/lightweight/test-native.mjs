import { spawn } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  copyFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { wave, WORD_LYRICS } from '../../scripts/fixtures/pcm.mjs'
const root = resolve(import.meta.dirname, '../..'),
  folder = join(root, 'apps/desktop/test-results/native-player-' + Date.now())
mkdirSync(folder, { recursive: true })
const first = join(folder, '暮色.wav'),
  second = join(folder, '流光.wav')
writeFileSync(first, wave({ seconds: 60 }))
writeFileSync(second, wave({ seconds: 60 }))
writeFileSync(first.replace('.wav', '.lrc'), WORD_LYRICS)
copyFileSync(
  join(root, 'apps/desktop/build/icon.png'),
  first.replace('.wav', '.png')
)
const handoff = join(folder, 'handoff.json')
writeFileSync(
  handoff,
  JSON.stringify({
    volume: 0.05,
    output: { api: 'null', deviceId: null, bufferMs: 40, dsdMode: 'pcm' },
    state: 'stopped',
  })
)
const child = spawn(
  join(
    root,
    'target/debug',
    process.platform === 'win32' ? 'jap-lightweight.exe' : 'jap-lightweight'
  ),
  [
    '--data-dir',
    folder,
    '--resources',
    join(root, 'apps/desktop/build'),
    '--handoff',
    handoff,
    '--qa',
  ],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
)
let logs = ''
child.stderr.on('data', (b) => (logs += b))
child.stdout.on('data', (b) => (logs += b))
const report = () => {
  try {
    return JSON.parse(readFileSync(join(folder, 'native-report.json'), 'utf8'))
  } catch {
    return null
  }
}
const wait = async (predicate) => {
  const until = Date.now() + 30000
  while (Date.now() < until) {
    const s = report()
    if (s && predicate(s)) return s
    if (child.exitCode !== null) throw Error('Native player exited: ' + logs)
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('Timeout: ' + predicate + ' ' + logs)
}
const send = async (value) => {
  const input = join(folder, 'native-input.json')
  const until = Date.now() + 5000
  while (existsSync(input) && Date.now() < until)
    await new Promise((r) => setTimeout(r, 50))
  writeFileSync(input + '.pending', JSON.stringify(value))
  renameSync(input + '.pending', input)
}
const checks = []
try {
  await wait((s) => s.renderer === 'egui-native')
  assert.equal(report().webview, false)
  assert.equal(report().visual, false)
  checks.push('native Rust window without a browser')
  await send({ type: 'import', paths: [first, second] })
  await wait((s) => s.library.lists[0].items.length === 2)
  checks.push('native file import and persistent queue')
  await send({ type: 'command', command: 'toggle' })
  await wait((s) => s.state === 'playing' && s.position > 500)
  checks.push('real engine playback')
  await wait((s) => s.hasCover && s.hasMediaCover && s.lyricLines > 0)
  checks.push('native cover, system media artwork and word lyrics')
  await send({ type: 'meter', id: 'vu', enabled: true })
  await wait((s) => s.analysisFrames > 3 && s.rms[0] > 0.005)
  assert.deepEqual(report().meters, ['vu'])
  checks.push('independent native VU receives PCM RMS')
  await send({ type: 'screenshot' })
  await wait(() => existsSync(join(folder, 'native-screenshot.png')))
  checks.push('native framebuffer screenshot')
  await send({ type: 'command', command: 'pause' })
  await wait((s) => s.state === 'paused' && !s.visual)
  const n = report().analysisFrames
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(report().analysisFrames, n)
  checks.push('pause suspends analysis')
  await send({ type: 'volume', gain: 0.07 })
  await wait((s) => Math.abs(s.volume - 0.07) < 0.0001)
  checks.push('native gain change')
  await send({ type: 'command', command: 'next' })
  await wait((s) => s.current?.path === second && s.state === 'playing')
  checks.push('queue next')
  assert.equal(report().error, null, JSON.stringify(report().error))
  writeFileSync(
    join(folder, 'passed.json'),
    JSON.stringify({ passed: true, checks }, null, 2)
  )
  console.log(JSON.stringify({ passed: true, checks, folder }, null, 2))
} finally {
  await send({ type: 'close' }).catch(() => {})
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(r, 3000)),
  ])
  if (child.exitCode === null) child.kill()
}
