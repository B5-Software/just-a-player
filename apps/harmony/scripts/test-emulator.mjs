import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connect, serial } from './cdp.mjs'
import { wave, flacLyrics, WORD_LYRICS } from '../../../scripts/fixtures/pcm.mjs'
import { writeMidi } from '../../../scripts/fixtures/midi.mjs'
const c = await connect(),
  checks = [],
  errors = []
const dir = fileURLToPath(new URL('../test-results/', import.meta.url))
fs.mkdirSync(dir, { recursive: true })
const wait = async (expression, timeout = 15000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await c.evaluate(expression)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('Timed out: ' + expression)
}
try {
  if (!(await c.evaluate('!!window.__jap'))) {
    await c.send('Page.navigate', { url: 'https://jap.localhost/index.html?e2e=1' })
    await wait('!!window.__jap?.usePlayer.getState().connected')
  }
  await c.evaluate(`(() => {
    const j=window.__jap;j.useSettings.getState().update({autoScan:false,autoHideControls:false,lyricsMode:'2d'});j.useUi.getState().setOnboardingOpen(false);
    j.usePlayer.getState().setOutput({api:'ohosShared',deviceId:null,dsdMode:'pcm'});j.usePlayer.getState().setVolume(0);
    window.__qaErrors=[];j.engine.onEvent(e=>{if(e.type==='error')window.__qaErrors.push(e.message)});
    let next=1000000;const pending=new Map(),old=window.__androidEvent;
    window.__androidEvent=(key,v)=>{if(key==='rpc'&&pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(Error(v.error)):p.resolve(v.value)}else old(key,v)};
    window.__qaRpc=(method,payload)=>new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});window.NativeHarmony.request(id,method,JSON.stringify(payload))});
  })()`)
  async function fixture(name, data) {
    return c.evaluate(
      `window.__qaRpc('qaWrite',${JSON.stringify({ name, data: data.toString('base64') })})`
    )
  }
  const audio = await fixture('qa.wav', wave()),
    lrc = await fixture('qa.lrc', Buffer.from(WORD_LYRICS))
  assert.ok(lrc.endsWith('/Music/qa.lrc'))
  const devices = await c.evaluate(
    `window.__jap.engine.query({type:'deviceFormats',api:'ohosShared',deviceId:null})`
  )
  assert.equal(devices.type, 'exclusiveFormats')
  assert.ok(devices.formats.some((f) => f.sampleRate === 48000 && f.channels === 2))
  checks.push('OHAudio device capability queried from a paused native stream')
  await c.evaluate(`window.__jap.usePlayer.getState().play(${JSON.stringify(audio)})`)
  await wait(
    "window.__jap.usePlayer.getState().state==='playing' && window.__jap.usePlayer.getState().position.ms>500"
  )
  const playback = await c.evaluate(
    `({signal:window.__jap.usePlayer.getState().signalPath,lyrics:window.__jap.useLyrics.getState(),words:document.querySelectorAll('[data-lyric-word]').length})`
  )
  assert.equal(playback.signal.verdict, 'systemMixed')
  assert.ok(playback.signal.nodes.some((n) => n.title.includes('OHAudio')))
  assert.equal(playback.lyrics.source, 'sidecar')
  assert.equal(playback.words, 6)
  await c.evaluate('window.__jap.usePlayer.getState().seek(2500)')
  await wait(
    'window.__jap.usePlayer.getState().position.ms>=2500 && window.__jap.usePlayer.getState().position.ms<3800'
  )
  await c.evaluate('window.__jap.usePlayer.getState().togglePause()')
  await wait("window.__jap.usePlayer.getState().state==='paused'")
  const before = await c.evaluate('window.__jap.usePlayer.getState().position.ms')
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(
    Math.abs((await c.evaluate('window.__jap.usePlayer.getState().position.ms')) - before) < 150
  )
  checks.push(
    'Actual OHAudio playback, seek, pause; system-mixed fidelity label; six timed lyric words'
  )
  const flac = await fixture(
    'qa-768.flac',
    flacLyrics(
      fs.readFileSync(new URL('../../../scripts/fixtures/pcm24-768.flac', import.meta.url))
    )
  )
  const info = await c.evaluate(`window.__jap.usePlayer.getState().probe(${JSON.stringify(flac)})`)
  assert.equal(info.format.sampleRate, 768000)
  assert.equal(info.format.bits, 24)
  assert.equal(info.codec, 'FLAC')
  const embedded = await c.evaluate(
    `window.__jap.engine.query({type:'embeddedLyrics',path:${JSON.stringify(flac)}})`
  )
  assert.equal(embedded.type, 'lyrics')
  assert.equal(embedded.text, WORD_LYRICS)
  checks.push('Native 24-bit / 768 kHz FLAC and embedded LYRICS metadata on HarmonyOS')
  const extreme = await fixture(
    'qa-rf64.wav',
    wave({ rate: 6144000, seconds: 0.04, bits: 64, rf64: true })
  )
  await c.evaluate(
    `window.__jap.usePlayer.getState().stop();window.__jap.usePlayer.getState().play(${JSON.stringify(extreme)})`
  )
  await wait(`window.__jap.usePlayer.getState().track?.path===${JSON.stringify(extreme)}`)
  const path = await c.evaluate('window.__jap.usePlayer.getState().signalPath')
  assert.ok(path.nodes.some((n) => n.kind === 'resampler' && n.title.includes('非 bit-perfect')))
  assert.equal(path.nodes.find((n) => n.kind === 'resampler').format.sampleRate, 48000)
  checks.push(
    '6.144 MHz / float64 RF64 streams through FFT anti-aliasing to the native 48 kHz OHAudio output'
  )
  writeMidi(dir + '/qa.mid', 4)
  const bank = await fixture(
    'qa.sf2',
    fs.readFileSync(new URL('../../../scripts/fixtures/sine.sf2', import.meta.url))
  )
  const font = await c.evaluate(`window.__qaRpc('importSoundfont',{path:${JSON.stringify(bank)}})`)
  assert.ok(font.includes('/soundfonts/user-'))
  const midi = await fixture('qa.mid', fs.readFileSync(dir + '/qa.mid'))
  await c.evaluate(
    `window.__jap.useSettings.getState().update({midiSoundfont:${JSON.stringify(font)}});window.__jap.usePlayer.getState().play(${JSON.stringify(midi)})`
  )
  await wait(
    `window.__jap.usePlayer.getState().track?.path===${JSON.stringify(midi)} && window.__jap.usePlayer.getState().position.ms>200`
  )
  const midiInfo = await c.evaluate('window.__jap.usePlayer.getState().track')
  assert.ok(midiInfo.codec.includes('MIDI'))
  checks.push(
    'Imported SF2 is copied to private storage and the shared Rust MIDI synthesizer plays through OHAudio'
  )
  errors.push(...(await c.evaluate('window.__qaErrors')))
  assert.deepEqual(errors, [])
  const graphics = await c.evaluate(
    `(()=>{const c=document.createElement('canvas');return{webgl:!!c.getContext('webgl2'),platform:window.jap.platform}})()`
  )
  assert.equal(graphics.platform, 'ohos')
  await c.evaluate(`window.__jap.usePlayer.getState().play(${JSON.stringify(audio)})`)
  await wait("window.__jap.usePlayer.getState().state==='playing'")
  const screenshot = await c.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(dir + '/player.png', Buffer.from(screenshot.data, 'base64'))
  await c.evaluate('window.__jap.usePlayer.getState().stop()')
  const report = {
    serial,
    checks,
    graphics,
    limitations: graphics.webgl
      ? []
      : [
          'Official HarmonyOS PC 7.0 emulator disables WebGL; 3D GPU rendering and HDR are not validated here.',
          'USB bit-perfect / DSD needs a real USB DAC and physical HarmonyOS PC.',
        ],
  }
  fs.writeFileSync(dir + '/report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  c.close()
}
