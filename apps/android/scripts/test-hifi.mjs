import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adb, adbInput, connect, delay } from './emulator-cdp.mjs'
import { wave, flacLyrics, WORD_LYRICS } from '../../../scripts/fixtures/pcm.mjs'
import { writeDiscFixtures } from '../../../scripts/fixtures/disc.mjs'
const app = 'org.b5_software.justaplayer.debug',
  out = fileURLToPath(new URL('../test-results/hifi/', import.meta.url))
fs.mkdirSync(out, { recursive: true })
writeDiscFixtures(out)
fs.writeFileSync(path.join(out, 'Word.wav'), wave())
fs.writeFileSync(path.join(out, 'Word.lrc'), WORD_LYRICS)
fs.writeFileSync(
  path.join(out, 'High.rf64.wav'),
  wave({ rate: 6144000, seconds: 0.04, rf64: true, bits: 64 })
)
fs.writeFileSync(
  path.join(out, 'Embedded.flac'),
  flacLyrics(fs.readFileSync(new URL('../../../scripts/fixtures/pcm24-768.flac', import.meta.url)))
)
adb(
  'shell',
  'am',
  'start',
  '-W',
  '-n',
  app + '/org.b5_software.justaplayer.MainActivity',
  '--ez',
  'e2e',
  'true'
)
const root = `/data/user/0/${app}/files/HiFiQA`
adb('shell', 'run-as', app, 'mkdir', '-p', 'files/HiFiQA')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
for (const file of fs.readdirSync(out).filter((f) => !f.endsWith('.json'))) {
  const data = fs.readFileSync(path.join(out, file)), target = root + '/' + file
  // Windows adb shell stdin is text mode: raw 0x1a can truncate a binary fixture.
  adbInput(Buffer.from(data.toString('base64')+'\n'), 'shell', '-T', 'run-as', app,
    'sh', '-c', quote('base64 -d > '+quote(target)))
  assert.equal(Number(adb('shell','run-as',app,'stat','-c','%s',quote(target))),data.length)
}
const c = await connect(),
  checks = []
async function wait(expression) {
  const until = Date.now() + 15000
  while (Date.now() < until) {
    if (await c.evaluate(expression)) return
    await delay(100)
  }
  throw Error('Timed out: ' + expression)
}
try {
  await wait('!!window.__jap?.usePlayer.getState().connected')
  await c.evaluate(
    `(()=>{const j=__jap;j.useUi.getState().setOnboardingOpen(false);j.useSettings.getState().update({autoScan:false,lyricsVisible:true,lyricsMode:'2d'});j.usePlayer.getState().setVolume(0);j.useDsp.getState().update({enabled:false});j.usePlayer.getState().setOutput({api:'androidShared',deviceId:null,dsdMode:'pcm'});window.__hifiErrors=[];j.engine.onEvent(e=>{if(e.type==='error')__hifiErrors.push(e.message)})})()`
  )
  const formats = await c.evaluate(
    `__jap.engine.query({type:'deviceFormats',api:'androidShared',deviceId:null})`
  )
  assert.equal(formats.type, 'exclusiveFormats')
  assert.ok(formats.formats.some((f) => f.sampleRate > 0 && f.format === 'f32'))
  checks.push('AAudio capability query returns an actual native stream format')
  const largePath = '/storage/emulated/0/Android/data/org.b5_software.justaplayer.debug/files/Music/Android Live.wav'
  const boundedRead = await c.evaluate(
    `window.jap.readFile(${JSON.stringify(largePath)}).then(()=>'',e=>e.message)`
  )
  assert.match(boundedRead, /流式播放/)
  const largeInfo = await c.evaluate(`__jap.usePlayer.getState().probe(${JSON.stringify(largePath)})`)
  assert.equal(largeInfo.durationMs, 300000)
  checks.push('Oversized whole-file UI reads are rejected before allocation; native streaming still probes the song')
  const info = await c.evaluate(
    `__jap.usePlayer.getState().probe(${JSON.stringify(root + '/Embedded.flac')})`
  )
  assert.equal(info.format.sampleRate, 768000)
  assert.equal(info.codec, 'FLAC')
  const lyrics = await c.evaluate(
    `__jap.engine.query({type:'embeddedLyrics',path:${JSON.stringify(root + '/Embedded.flac')}})`
  )
  assert.equal(lyrics.text, WORD_LYRICS)
  checks.push('Native 24/768 FLAC and embedded LYRICS pass through the Android JNI bridge')
  await c.evaluate(`__jap.usePlayer.getState().play(${JSON.stringify(root + '/High.rf64.wav')})`)
  await wait(`__jap.usePlayer.getState().track?.path===${JSON.stringify(root + '/High.rf64.wav')}`)
  const signal = await c.evaluate('__jap.usePlayer.getState().signalPath')
  const conversion = signal.nodes.find((n) => n.kind === 'resampler')
  assert.ok(conversion?.title.includes('非 bit-perfect'))
  assert.equal(conversion.format.sampleRate, formats.formats[0].sampleRate)
  assert.equal(signal.verdict, 'systemMixed')
  checks.push(
    '6.144 MHz float64 RF64 automatically adapts to AAudio and is not labeled bit-perfect'
  )
  const names = fs.readdirSync(out),
    iso = names.find((f) => f.endsWith('.iso')),
    cue = names.find((f) => f.endsWith('.cue')),
    bin = names.find((f) => f.endsWith('.bin'))
  const tracks = await c.evaluate(
    `(async()=>{const j=__jap,id=j.useLibrary.getState().createList('HiFi QA');await j.addAudioPaths(${JSON.stringify([iso, cue, bin].map((n) => root + '/' + n))},false,id);return j.useLibrary.getState().lists.find(l=>l.id===id).items})()`
  )
  assert.equal(tracks.length, 4)
  assert.deepEqual(
    tracks.map((t) => t.title),
    ['SACD Track 1', 'SACD Track 2', 'CD First', 'CD Second']
  )
  const discPath = tracks[0].path
  await c.evaluate(`__jap.usePlayer.getState().play(${JSON.stringify(discPath)})`)
  await wait(
    `__jap.usePlayer.getState().track?.path===${JSON.stringify(discPath)}&&__jap.usePlayer.getState().state==='playing'`
  )
  assert.equal(await c.evaluate('__jap.usePlayer.getState().track.format.bits'), 1)
  checks.push(
    'SACD ISO / CD CUE import as four deduplicated subsongs; one SACD track plays through the native engine'
  )
  await c.evaluate(`__jap.usePlayer.getState().play(${JSON.stringify(root + '/Word.wav')})`)
  await wait(
    `__jap.useLyrics.getState().source==='sidecar'&&document.querySelectorAll('[data-lyric-word]').length===6`
  )
  checks.push('Six timed word spans are displayed from an actual Android sidecar lyric file')
  assert.deepEqual(await c.evaluate('__hifiErrors'), [])
  await c.evaluate('__jap.usePlayer.getState().stop()')
  assert.deepEqual(c.errors, [])
  const report = { status: 'passed', checks }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  c.close()
}
