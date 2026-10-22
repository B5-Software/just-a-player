import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adb, adbBytes, connect, delay } from './emulator-cdp.mjs'
const root = fileURLToPath(new URL('..', import.meta.url)),
  results = path.join(root, 'test-results')
fs.mkdirSync(results, { recursive: true })
const app = 'org.b5_software.justaplayer.debug',
  activity = 'org.b5_software.justaplayer.MainActivity'
const deviceRoot = `/sdcard/Android/data/${app}/files/Music`
const fixtures = path.join(results, 'fixtures')
fs.mkdirSync(fixtures, { recursive: true })
function wav(seconds = 60) {
  const rate = 44100,
    n = rate * seconds,
    b = Buffer.alloc(44 + n * 4)
  b.write('RIFF')
  b.writeUInt32LE(b.length - 8, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(2, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 4, 28)
  b.writeUInt16LE(4, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 1300)
    b.writeInt16LE(s, 44 + i * 4)
    b.writeInt16LE(s, 46 + i * 4)
  }
  return b
}
function dsf() {
  const samples = 2822400 * 4,
    blocks = Math.ceil(samples / 8 / 4096),
    size = 28 + 52 + 12 + blocks * 4096 * 2,
    b = Buffer.alloc(size, 0x69)
  b.fill(0, 0, 92)
  b.write('DSD ')
  b.writeBigUInt64LE(28n, 4)
  b.writeBigUInt64LE(BigInt(size), 12)
  b.write('fmt ', 28)
  b.writeBigUInt64LE(52n, 32)
  ;[1, 0, 2, 2, 2822400, 1].forEach((v, i) => b.writeUInt32LE(v, 40 + i * 4))
  b.writeBigUInt64LE(BigInt(samples), 64)
  b.writeUInt32LE(4096, 72)
  b.write('data', 80)
  b.writeBigUInt64LE(BigInt(size - 80), 84)
  return b
}
fs.writeFileSync(path.join(fixtures, 'Android HiFi.wav'), wav())
// Give software-GPU CI enough music for all queued exports without reaching EOF.
fs.writeFileSync(path.join(fixtures, 'Android Live.wav'), wav(300))
fs.writeFileSync(path.join(fixtures, 'Android DSD64.dsf'), dsf())
fs.writeFileSync(
  path.join(fixtures, 'Android HiFi.lrc'),
  '[00:00.00]音乐，让此刻发光\n[00:01.00]Just A Player · Android\n[00:03.00]同一片音乐舞台\n'
)
fs.copyFileSync(
  fileURLToPath(new URL('./fixtures/tone.dts', import.meta.url)),
  path.join(fixtures, 'Android DTS.dts')
)
fs.copyFileSync(
  fileURLToPath(new URL('../../../scripts/fixtures/pcm24-768.flac', import.meta.url)),
  path.join(fixtures, '24-768.flac')
)
if (process.argv.includes('--install'))
  adb('install', '-r', path.join(root, 'app/build/outputs/apk/debug/app-debug.apk'))
adb('shell', 'am', 'force-stop', app)
adb('logcat', '-c')
adb('shell', 'am', 'start', '-n', `${app}/${activity}`, '--ez', 'e2e', 'true')
await delay(2500)
adb('shell', 'mkdir', '-p', deviceRoot)
for (const name of fs.readdirSync(fixtures))
  adb('push', path.join(fixtures, name), deviceRoot + '/' + name)
const c = await connect(),
  report = {
    package: app,
    abi: adb('shell', 'getprop', 'ro.product.cpu.abi'),
    checks: [],
  }
async function wait(expression, label, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await c.evaluate(expression)) {
      report.checks.push(label)
      return
    }
    await delay(200)
  }
  throw Error(
    `Timed out: ${label}; ${JSON.stringify(await c.evaluate(`({state:__jap.usePlayer.getState().state,error:__jap.usePlayer.getState().error,body:document.body.innerText.slice(-600)})`))}`
  )
}
async function shot(name) {
  fs.writeFileSync(path.join(results, name + '.png'), adbBytes('exec-out', 'screencap', '-p'))
}
const q = JSON.stringify
try {
  await wait(
    `!!window.__jap&&__jap.usePlayer.getState().connected`,
    'WebView ↔ JNI engine connected'
  )
  assert.ok(await c.evaluate('innerWidth>innerHeight'), 'Android must start in landscape')
  report.checks.push('Forced landscape')
  await c.evaluate(
    `__jap.useUi.getState().setOnboardingOpen(false);__jap.useSettings.getState().update({onboardingComplete:true,autoScan:false});`
  )
  await c.evaluate(
    `window.__dialogs=0;window.alert=window.confirm=window.prompt=()=>{window.__dialogs++;throw Error('Native browser dialog forbidden')};`
  )
  // Exercise the actual custom file dialog, including address entry and selection.
  await c.evaluate(`document.querySelector('[aria-label="打开文件"]').click()`)
  await wait(`!!document.querySelector('[data-app-dialog]')`, 'Styled file browser opens')
  await c.evaluate(
    `(()=>{const input=document.querySelector('[aria-label="文件夹路径"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,${q(deviceRoot)});input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})()`
  )
  await wait(
    `!![...document.querySelectorAll('[role="option"]')].find(n=>n.textContent.includes('Android HiFi.wav'))`,
    'Native filesystem visible in custom browser'
  )
  await c.evaluate(
    `([...document.querySelectorAll('[role="option"]')].find(n=>n.textContent.includes('Android HiFi.wav'))).click()`
  )
  await c.evaluate(
    `([...document.querySelectorAll('[data-app-dialog] button')].find(n=>n.textContent==='打开')).click()`
  )
  await wait(
    `!document.querySelector('[data-app-dialog]')&&__jap.useLibrary.getState().lists.some(l=>l.items.some(i=>i.path.endsWith('Android HiFi.wav')))`,
    'Import through custom dialog'
  )
  await c.evaluate(`__jap.usePlayer.getState().play(${q(deviceRoot + '/Android HiFi.wav')})`)
  await wait(
    `__jap.usePlayer.getState().state==='playing'&&__jap.usePlayer.getState().position.ms>400`,
    'AAudio plays WAV'
  )
  assert.ok(Math.abs((await c.evaluate('__jap.usePlayer.getState().volume')) - 0.2) < 1e-6)
  report.checks.push('Safe 20% default volume')
  await wait(`!!__jap.usePlayer.getState().signalPath`, 'Real signal path received')
  const flac = await c.evaluate(
    `(async()=>{const path=${q(deviceRoot + '/24-768.flac')},j=__jap,info=await j.usePlayer.getState().probe(path);const job=await j.engine.offline('open',{path,writeAudio:true,startMs:5});await j.engine.offline('frame',{timeMs:100});await j.engine.offline('close');return {info,data:Array.from(await window.jap.readFile(job.audioPath))}})()`
  )
  assert.equal(flac.info.format.sampleRate, 768000)
  assert.equal(flac.info.format.bits, 24)
  const pcm768 = Buffer.from(flac.data),
    at768 = pcm768.indexOf('data') + 8
  assert.equal(pcm768.length - at768, (8192 - 3840) * 8)
  for (let i = 3840; i < 8192; i++) {
    assert.equal(
      pcm768.readInt32LE(at768 + (i - 3840) * 8),
      (((i * 3511) % 14000001) - 7000000) * 256
    )
    assert.equal(
      pcm768.readInt32LE(at768 + (i - 3840) * 8 + 4),
      (7000000 - ((i * 7193) % 14000001)) * 256
    )
  }
  report.checks.push('24-bit / 768 kHz FLAC: exact sample values after a 5 ms seek')
  await c.evaluate(
    `__jap.useDsp.getState().update({enabled:true,preampDb:-6,eqDb:[3,2,1,0,0,0,1,2,1,0]})`
  )
  await wait(`__jap.useDsp.getState().config.enabled`, 'Rust DSP / EQ works')
  await c.evaluate(`__jap.usePlayer.getState().resetBuffer()`)
  await wait(`__jap.usePlayer.getState().bufferResets>0`, 'Buffer reset works')
  await c.evaluate(`__jap.useUi.getState().togglePanel('output')`)
  await wait(`!!document.querySelector('#dsd-mode')`, 'Output panel is mounted')
  await c.evaluate(`document.querySelector('#dsd-mode').click()`)
  await wait(
    `!!document.querySelector('[role="listbox"]')`,
    'Styled select replaces Android platform picker'
  )
  await c.evaluate(
    `document.querySelector('[role="listbox"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
  )
  await wait(
    `!!document.querySelector('[data-panel-root="output"]')&&!document.querySelector('[role="listbox"]')`,
    'Closing select preserves parent panel'
  )
  await c.evaluate(
    `__jap.useUi.getState().closePanel();__jap.useQuality.getState().analyze(${q(deviceRoot + '/Android HiFi.wav')})`
  )
  await wait(`!!__jap.useQuality.getState().report`, 'Native audio quality analysis', 30000)
  await shot('landscape-playback')
  const before = await c.evaluate('__jap.usePlayer.getState().position.ms')
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await delay(1500)
  await wait(
    `document.documentElement.dataset.renderSuspended==='1'`,
    'Background suspends GPU rendering'
  )
  const frame = await c.evaluate('__japViz.frameVersion')
  await delay(600)
  assert.equal(await c.evaluate('__japViz.frameVersion'), frame)
  assert.ok((await c.evaluate('__jap.usePlayer.getState().position.ms')) > before)
  report.checks.push('Audio continues in background')
  adb('shell', 'input', 'keyevent', 'KEYCODE_MEDIA_PAUSE')
  await wait(
    `__jap.usePlayer.getState().state==='paused'`,
    'System media pause controls native engine'
  )
  report.mediaSession = adb('shell', 'dumpsys', 'media_session').includes('Just A Player')
  assert.ok(report.mediaSession)
  adb('shell', 'am', 'start', '-n', `${app}/${activity}`)
  await wait(
    `document.documentElement.dataset.renderSuspended===''`,
    'Foreground resumes rendering'
  )
  await c.evaluate(
    `__jap.useDsp.getState().update({enabled:false});__jap.usePlayer.getState().play(${q(deviceRoot + '/Android DSD64.dsf')})`
  )
  await wait(
    `__jap.usePlayer.getState().track?.format.bits===1&&__jap.usePlayer.getState().state==='playing'`,
    'DSD64 decodes through shared Rust engine'
  )
  await c.evaluate(`__jap.usePlayer.getState().stop()`)
  await c.evaluate(`__jap.usePlayer.getState().play(${q(deviceRoot + '/Android DTS.dts')})`)
  await wait(
    `__jap.usePlayer.getState().track?.path.endsWith('Android DTS.dts')&&__jap.usePlayer.getState().error===null`,
    'DTS plays through APK-bundled FFmpeg',
    30000
  )
  await c.evaluate(`__jap.usePlayer.getState().play(${q(deviceRoot + '/Android Live.wav')})`)
  await wait(
    `__jap.usePlayer.getState().state==='playing'&&__jap.usePlayer.getState().track?.path.endsWith('Android Live.wav')`,
    'Live audio ready during export'
  )
  report.exports = []
  // Queue complete rendered jobs; the foreground audio and stage keep running.
  await c.evaluate(
    `window.__exportGaps=[];window.__lastPulse=performance.now();window.__pulse=setInterval(()=>{const n=performance.now();__exportGaps.push(n-__lastPulse);__lastPulse=n},100)`
  )
  for (const audio of ['aac', 'opus', 'flac', 'pcm', 'copy']) {
    const target = deviceRoot + '/Android-QA-' + audio + (audio === 'aac' ? '.mp4' : '.mkv')
    await c.evaluate(
      `window.__queued=__jap.exportVideo({path:${q(deviceRoot + '/Android HiFi.wav')},width:320,height:180,fps:24,quality:28,encoder:${q(audio === 'aac' ? 'auto' : 'cpu')},intro:0.125,outro:0.125,start:0,end:0.5,lyrics:'3d',audio:${q(audio)},signature:'B5-Software'});true`
    )
    await wait(
      `!!__jap.useDialogs.getState().queue.find(i=>i.kind==='file')`,
      'Queue destination ' + audio
    )
    await c.evaluate(
      `(async()=>{const item=__jap.useDialogs.getState().queue.find(i=>i.kind==='file');await window.jap.dialogReply(item.id,[${q(target)}]);__jap.useDialogs.getState().remove(item.id);return true})()`
    )
    const item = await c.evaluate('window.__queued')
    assert.ok(item?.id)
    if (audio === 'aac') {
      await wait(
        `__jap.useVideoQueue.getState().jobs.some(i=>i.state==='rendering')`,
        'Independent export starts'
      )
      const mainPid = adb('shell', 'pidof', app),
        workerPid = adb('shell', 'pidof', app + ':video')
      assert.ok(
        workerPid && workerPid !== mainPid,
        'Export must run outside the foreground Activity process'
      )
      report.exportProcesses = { main: mainPid, worker: workerPid }
    }
    report.exports.push({ audio, id: item.id, target })
  }
  await wait(
    `__jap.useVideoQueue.getState().jobs.length===5&&__jap.useVideoQueue.getState().jobs.every(i=>['done','failed','cancelled'].includes(i.state))`,
    'Five background export jobs finished',
    180000
  )
  const jobs = await c.evaluate('__jap.useVideoQueue.getState().jobs')
  assert.ok(
    jobs.every((j) => j.state === 'done'),
    JSON.stringify(jobs)
  )
  assert.equal(await c.evaluate('__jap.usePlayer.getState().state'), 'playing')
  report.maxForegroundGapMs = await c.evaluate(
    `(()=>{clearInterval(__pulse);return Math.max(...__exportGaps)})()`
  )
  assert.ok(
    report.maxForegroundGapMs < 5000,
    'Foreground event loop stalled during offline export: ' + report.maxForegroundGapMs
  )
  report.checks.push('All five export audio modes finish while live audio continues')
  for (const e of report.exports) {
    // Read through the app's actual storage permissions; adb's mount namespace
    // cannot read app-created files under Android scoped storage.
    const data = Buffer.from(
      await c.evaluate(
        `(async()=>{const b=await window.jap.readFile(${q(e.target)});if(!b)throw Error('Export unreadable');let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s)})()`
      ),
      'base64'
    )
    assert.ok(data.length > 1000, 'Export file is empty')
    assert.equal(
      e.audio === 'aac' ? data.subarray(4, 8).toString() : data.subarray(0, 4).toString('hex'),
      e.audio === 'aac' ? 'ftyp' : '1a45dfa3',
      'Export container header is invalid'
    )
    fs.writeFileSync(path.join(results, path.basename(e.target)), data)
  }
  for (const [name, end] of [
    ['cancel', 20],
    ['after-cancel', 0.25],
  ]) {
    const target = deviceRoot + '/Android-QA-' + name + '.mp4'
    await c.evaluate(
      `window.__queued=__jap.exportVideo({path:${q(deviceRoot + '/Android HiFi.wav')},width:320,height:180,fps:24,quality:28,encoder:'cpu',intro:0,outro:0,start:0,end:${end},lyrics:'none',audio:'aac'});true`
    )
    await wait(`!!__jap.useDialogs.getState().queue.find(i=>i.kind==='file')`, 'Queue ' + name)
    await c.evaluate(
      `(async()=>{const item=__jap.useDialogs.getState().queue.find(i=>i.kind==='file');await window.jap.dialogReply(item.id,[${q(target)}]);__jap.useDialogs.getState().remove(item.id);return true})()`
    )
    const queued = await c.evaluate('window.__queued')
    if (name === 'cancel') {
      await wait(
        `__jap.useVideoQueue.getState().jobs.find(i=>i.id===${q(queued.id)})?.state==='rendering'`,
        'Cancellation target starts'
      )
      await c.evaluate(`window.jap.cancelVideoJob(${q(queued.id)})`)
      await wait(
        `__jap.useVideoQueue.getState().jobs.find(i=>i.id===${q(queued.id)})?.state==='cancelled'`,
        'Cancellation releases worker'
      )
    } else {
      await wait(
        `['done','failed'].includes(__jap.useVideoQueue.getState().jobs.find(i=>i.id===${q(queued.id)})?.state)`,
        'Queue recovers after cancellation',
        90000
      )
      assert.equal(
        await c.evaluate(
          `__jap.useVideoQueue.getState().jobs.find(i=>i.id===${q(queued.id)}).state`
        ),
        'done'
      )
    }
  }
  assert.equal(await c.evaluate('__jap.usePlayer.getState().state'), 'playing')
  report.checks.push(
    'Cancellation releases the export process and the next task completes; live audio continues'
  )
  await c.evaluate(`__jap.usePlayer.getState().stop()`)
  assert.equal(await c.evaluate('window.__dialogs'), 0)
  assert.equal(
    await c.evaluate(`document.querySelectorAll('select,input[type="color"]').length`),
    0
  )
  report.checks.push('No browser/native select/color dialogs')
  if (c.errors.length) throw Error(JSON.stringify(c.errors))
  report.status = 'passed'
  fs.writeFileSync(path.join(results, 'emulator.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  c.close()
}
