import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adb, adbBytes, connect, delay } from './emulator-cdp.mjs'
import { writeMidi } from '../../../scripts/fixtures/midi.mjs'
const out = fileURLToPath(new URL('../test-results/touch-midi/', import.meta.url))
fs.mkdirSync(out, { recursive: true })
const app = 'org.b5_software.justaplayer.debug',
  activity = app + '/org.b5_software.justaplayer.MainActivity'
const fixture = path.join(out, 'AndroidMidiQA.mid')
writeMidi(fixture)
adb('push', fixture, '/sdcard/Music/AndroidMidiQA.mid')
let rows = adb(
  'shell',
  'content',
  'query',
  '--uri',
  'content://media/external/audio/media',
  '--projection',
  '_id:_display_name'
)
let id = rows.match(/_id=(\d+), _display_name=AndroidMidiQA.mid/)?.[1]
if (!id) {
  adb(
    'shell',
    'content',
    'insert',
    '--uri',
    'content://media/external/audio/media',
    '--bind',
    '_data:s:/storage/emulated/0/Music/AndroidMidiQA.mid',
    '--bind',
    '_display_name:s:AndroidMidiQA.mid',
    '--bind',
    'mime_type:s:audio/midi'
  )
  rows = adb(
    'shell',
    'content',
    'query',
    '--uri',
    'content://media/external/audio/media',
    '--projection',
    '_id:_display_name'
  )
  id = rows.match(/_id=(\d+), _display_name=AndroidMidiQA.mid/)?.[1]
}
assert.ok(id, 'MediaStore fixture URI')
const open = () =>
  adb(
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    activity,
    '-a',
    'android.intent.action.VIEW',
    '-t',
    'audio/midi',
    '-d',
    `content://media/external/audio/media/${id}`,
    '-f',
    '0x10000001',
    '--ez',
    'e2e',
    'true'
  )
adb('shell', 'am', 'force-stop', app)
adb('shell', 'am', 'start', '-W', '-n', activity, '--ez', 'e2e', 'true')
let c
for (let n = 0; n < 30; n++) {
  try {
    c = await connect()
    break
  } catch {
    await delay(500)
  }
}
assert.ok(c, 'WebView connected')
const report = { status: 'running', checks: [] },
  q = JSON.stringify
async function wait(expression, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await c.evaluate(expression)) {
      if (label) report.checks.push(label)
      return
    }
    await delay(120)
  }
  throw Error(
    `Timed out ${label || expression}: ${JSON.stringify(await c.evaluate('({state:__jap.usePlayer.getState().state,error:__jap.usePlayer.getState().error})'))}`
  )
}
const touch = (type, x, y) => {
  return c.send('Input.dispatchTouchEvent', {
    type,
    // Let Chromium timestamp real input; host and emulator clocks can differ.
    touchPoints: ['touchEnd', 'touchCancel'].includes(type)
      ? []
      : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
  })
}
const tap = async (x, y) => {
  await touch('touchStart', x, y)
  await touch('touchEnd')
}
const drag = async (x, y, dx, dy, hold = 0) => {
  await touch('touchStart', x, y)
  if (hold) await delay(hold)
  for (let n = 1; n <= 6; n++) {
    await touch('touchMove', x + (dx * n) / 6, y + (dy * n) / 6)
    await delay(25)
  }
  await touch('touchEnd')
}
const rect = (selector) =>
  c.evaluate(
    `(()=>{const e=document.querySelector(${q(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`
  )
const shot = (name) =>
  fs.writeFileSync(path.join(out, name + '.png'), adbBytes('exec-out', 'screencap', '-p'))
const foreground = () => adb('shell', 'am', 'start', '-W', '-n', activity, '--ez', 'e2e', 'true')
const flags = () => {
  const dump = adb('shell', 'dumpsys', 'window', 'windows')
  const blocks = dump.split(/\n  Window #/)
  return (
    blocks.find(
      (b) => b.split('\n')[0].includes(app) && b.split('\n')[0].includes('MainActivity')
    ) || dump
  )
}
async function awake(expected) {
  for (let n = 0; n < 30; n++) {
    if (flags().includes('KEEP_SCREEN_ON') === expected) return
    await delay(150)
  }
  assert.equal(
    flags().includes('KEEP_SCREEN_ON'),
    expected,
    'WindowManager did not apply the requested screen-awake state'
  )
}
try {
  await wait(`!!window.__jap&&__jap.usePlayer.getState().connected`)
  if (!(await c.evaluate('window.jap.bundledMidi'))) {
    const bank = fileURLToPath(new URL('../../../scripts/fixtures/sine.sf2', import.meta.url))
    const target = `/storage/emulated/0/Android/data/${app}/files/Music/OriginalSine.sf2`
    adb('push', bank, target)
    await c.evaluate('window.__font=window.jap.importSoundfont();true')
    await wait(`!!__jap.useDialogs.getState().queue.find(i=>i.kind==='file')`)
    await c.evaluate(
      `(async()=>{const item=__jap.useDialogs.getState().queue.find(i=>i.kind==='file');await window.jap.dialogReply(item.id,[${q(target)}]);__jap.useDialogs.getState().remove(item.id);return true})()`
    )
    const imported = await c.evaluate('window.__font')
    assert.ok(imported)
    await c.evaluate(`__jap.useSettings.getState().update({midiSoundfont:${q(imported)}})`)
    await delay(500)
    report.checks.push('without-midi imports an SF2 through the themed chooser')
  } else {
    await c.evaluate(`__jap.useSettings.getState().update({midiSoundfont:''})`)
    await delay(500)
  }
  c.close()
  adb('shell', 'am', 'force-stop', app)
  open()
  await delay(1500)
  c = await connect()
  await wait(
    `!!window.__jap&&__jap.usePlayer.getState().track?.codec.startsWith('MIDI')&&__jap.usePlayer.getState().state==='playing'`,
    'Cold content URI opens and plays MIDI through AAudio',
    60000
  )
  report.track = await c.evaluate('__jap.usePlayer.getState().track')
  assert.equal(report.track.format.sampleRate, 96000)
  assert.equal(report.track.format.float, true)
  assert.ok(report.track.path.includes('/Opened/'))
  await c.evaluate(
    `__jap.useUi.getState().setOnboardingOpen(false);__jap.useSettings.getState().update({onboardingComplete:true,autoScan:false,autoHideControls:false,renderFps:30});__jap.useLibrary.getState().createList('触屏测试保留列表')`
  )
  open()
  await wait(
    `__jap.useLibrary.getState().activeListId==='jap-external-files'`,
    'Warm VIEW preserves other playlists'
  )
  assert.ok(
    await c.evaluate(`__jap.useLibrary.getState().lists.some(l=>l.name==='触屏测试保留列表')`)
  )
  const live = `/storage/emulated/0/Android/data/${app}/files/Music/Android Live.wav`
  // This long fixture is generated by the main emulator suite, which runs first.
  await c.evaluate(
    `__jap.usePlayer.getState().play(${q(live)});__jap.useViz.getState().setAuto(false);__jap.useViz.getState().setScene('orb');__jap.useViz.getState().setOffset({x:0,y:0})`
  )
  await wait(
    `__jap.usePlayer.getState().state==='playing'&&__jap.usePlayer.getState().track?.path===${q(live)}`,
    'Live WAV continues during touch tests'
  )
  await drag(260, 150, 120, 22)
  const moved = await c.evaluate('__jap.useViz.getState().offset')
  assert.ok(moved.x > 100, JSON.stringify(moved))
  await touch('touchStart', 260, 150)
  await touch('touchMove', 280, 155)
  await touch('touchCancel')
  const cancelled = await c.evaluate('__jap.useViz.getState().offset')
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 450, y: 160, buttons: 0 })
  assert.deepEqual(await c.evaluate('__jap.useViz.getState().offset'), cancelled)
  report.checks.push('Real touch drag survives the pan threshold and cancels cleanly')
  await c.evaluate(
    `document.activeElement?.blur();__jap.useSettings.getState().update({autoHideControls:true})`
  )
  await wait(
    `getComputedStyle(document.querySelector('[data-player-topbar]')).opacity==='0'`,
    null,
    10000
  )
  await tap(260, 150)
  await delay(400)
  assert.equal(
    await c.evaluate(`getComputedStyle(document.querySelector('[data-player-topbar]')).opacity`),
    '1'
  )
  report.checks.push('Tap without moving reveals hidden controls')
  await c.evaluate(`__jap.useSettings.getState().update({autoHideControls:false})`)
  const vs = '[role="slider"][aria-label="应用内音量"]',
    vr = await rect(vs)
  const value = (s) =>
    c.evaluate(`Number(document.querySelector(${q(s)}).getAttribute('aria-valuenow'))`)
  const before = await value(vs)
  await tap(vr.x + vr.w * 0.9, vr.y + vr.h / 2)
  assert.equal(await value(vs), before)
  await drag(vr.x + vr.w / 2, vr.y + vr.h / 2, 0, -65)
  assert.equal(await value(vs), before)
  await drag(vr.x + vr.w * 0.2, vr.y + vr.h / 2, vr.w * 0.3, 0)
  await delay(150)
  assert.ok((await value(vs)) > before + 15)
  await c.evaluate('__jap.usePlayer.getState().setVolume(0.2)')
  const ss = '[role="slider"][aria-label="播放进度"]',
    sr = await rect(ss),
    position = await value(ss)
  await tap(sr.x + sr.w * 0.9, sr.y + sr.h / 2)
  assert.ok((await value(ss)) < position + 2000)
  report.checks.push(
    'Touch slider taps and scrolls cannot change volume or seek; deliberate drag works'
  )
  await c.evaluate(
    `__jap.useDsp.getState().update({eqDb:Array(10).fill(0)});__jap.useUi.getState().togglePanel('dsp')`
  )
  await delay(300)
  const es = '[role="slider"][aria-label="EQ 31.25 Hz"]'
  await wait(`document.querySelector(${q(es)})?.getAttribute('aria-valuenow')==='0'`)
  await c.evaluate(`document.querySelector(${q(es)}).scrollIntoView({block:'center'})`)
  let er = await rect(es),
    eq = await value(es)
  await drag(er.x + er.w / 2, er.y + er.h / 2, 0, -25)
  assert.equal(await value(es), eq)
  er = await rect(es)
  await drag(er.x + er.w / 2, er.y + er.h / 2, 0, -25, 240)
  assert.notEqual(await value(es), eq)
  report.checks.push('Vertical EQ distinguishes scrolling from hold-and-drag')
  await c.evaluate(
    `__jap.useUi.getState().closePanel();__jap.useDsp.getState().update({enabled:false});__jap.useSettings.getState().update({lyricsPosition:'custom',lyricsOffset:{x:0,y:0,z:0},lyricsRotation:{x:0,y:0,z:0},lyricsPose:'none'});__jap.useUi.getState().setOnboardingOpen(true)`
  )
  await delay(1800)
  // Step one must already display the preview; step two makes it draggable.
  assert.ok(await c.evaluate('__japLyrics.lines.some(l=>l.o?.grp.visible)'))
  await c.evaluate(
    `([...document.querySelectorAll('[data-onboarding] button')].find(b=>b.textContent==='下一步')).click()`
  )
  await wait(
    '__jap.useUi.getState().lyricsAdjusting&&__japLyrics.interactive',
    'Onboarding preview lyrics are available for adjustment'
  )
  await delay(300)
  const anchor = await c.evaluate(
    `(()=>{const r=__japLyrics,box=r.canvas.getBoundingClientRect();r.scene.updateMatrixWorld(true);for(const line of [...r.lines].filter(l=>l.o?.grp.visible&&l.o.mat.opacity>.1).sort((a,b)=>b.o.mat.opacity-a.o.mat.opacity)){const points=[];line.o.grp.traverse(mesh=>{if(!mesh.isMesh)return;mesh.geometry.computeBoundingBox();const p=mesh.geometry.boundingBox.getCenter(mesh.position.clone());mesh.localToWorld(p);p.project(r.camera);const x=box.x+(p.x+1)*box.width/2,y=box.y+(1-p.y)*box.height/2;if(document.elementFromPoint(x,y)===r.canvas)points.push({x,y})});if(points.length)return points[Math.floor(points.length/2)]}throw Error('No unobscured preview glyph to drag')})()`
  )
  report.lyricAnchor = anchor
  await c.evaluate(
    `(()=>{window.__lyricTouchQA=[];const r=__japLyrics;for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'])r.canvas.addEventListener(type,e=>{window.__lyricTouchQA.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,pointerType:e.pointerType,dragging:r.dragging,pointer:r.dragPointer});},{capture:true,passive:true})})()`
  )
  const initialLyrics = await c.evaluate('__jap.useSettings.getState().lyricsOffset')
  await drag(anchor.x, anchor.y, -65, 20)
  // Old WebViews may acknowledge CDP input before delivering pointerup to JS.
  // Require the real release handler to commit, rather than assuming it ran synchronously.
  await wait(
    `JSON.stringify(__jap.useSettings.getState().lyricsOffset)!==${q(JSON.stringify(initialLyrics))}`,
    null,
    3000
  )
  const lyrics = await c.evaluate('__jap.useSettings.getState().lyricsOffset')
  assert.notDeepEqual(lyrics, initialLyrics)
  assert.ok(Math.abs(lyrics.x-initialLyrics.x)>.06, 'Lyric drag must survive the scroll threshold for its full distance')
  await c.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: anchor.x - 90,
    y: anchor.y + 30,
    buttons: 0,
  })
  await delay(120)
  assert.deepEqual(await c.evaluate('__jap.useSettings.getState().lyricsOffset'), lyrics)
  report.checks.push('3D lyrics use real touch capture and stop moving after release')
  await c.evaluate(
    `(()=>{const j=__jap;j.useUi.getState().setOnboardingOpen(false);const l=j.useLibrary.getState();l.setFilter('');const id=l.createList('触屏排序');l.addPaths(id,[${q(live)},${q(`/storage/emulated/0/Android/data/${app}/files/Music/Android HiFi.wav`)}]);j.useUi.getState().togglePanel('playlist')})()`
  )
  await wait(`document.querySelectorAll('button[aria-label^="拖动排序 "]').length===2`)
  await c.evaluate(
    `document.querySelector('button[aria-label^="拖动排序 "]').scrollIntoView({block:'center'})`
  )
  await delay(250)
  const orderBefore = await c.evaluate(
    `__jap.useLibrary.getState().lists.find(l=>l.id===__jap.useLibrary.getState().activeListId).items.map(i=>i.id)`
  )
  const handles = await c.evaluate(
    `[...document.querySelectorAll('button[aria-label^="拖动排序 "]')].map(e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})`
  )
  assert.equal(
    await c.evaluate(`getComputedStyle(document.querySelector('button[aria-label^="拖动排序 "]')).touchAction`),
    'none',
    'Global button styles must not let browser scrolling cancel reorder gestures'
  )
  await drag(handles[0].x, handles[0].y, handles[1].x - handles[0].x, handles[1].y - handles[0].y)
  const orderAfter = await c.evaluate(
    `__jap.useLibrary.getState().lists.find(l=>l.id===__jap.useLibrary.getState().activeListId).items.map(i=>i.id)`
  )
  assert.deepEqual(orderAfter, [orderBefore[1], orderBefore[0]])
  report.checks.push('Playlist handles reorder with a real touch drag')
  await c.evaluate('__jap.useUi.getState().closePanel()')
  await c.evaluate(
    `__jap.useUi.getState().setOnboardingOpen(false);__jap.useSettings.getState().update({keepScreenAwake:true})`
  )
  await delay(800)
  await awake(true)
  await c.evaluate('__jap.usePlayer.getState().togglePause()')
  await wait(`__jap.usePlayer.getState().state==='paused'`)
  await delay(300)
  await awake(false)
  await c.evaluate('__jap.usePlayer.getState().togglePause()')
  await delay(500)
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await delay(500)
  await awake(false)
  foreground()
  await awake(true)
  report.checks.push('Keep-screen-awake flag follows playing, paused and foreground state')
  report.hdr = await c.evaluate('window.jap.nativeHdr.info')
  assert.equal(report.hdr.supported, false, 'Software emulator is an SDR display')
  const rejected = await c.evaluate(
    `window.jap.nativeHdr.configure(true).then(()=>'',e=>e.message)`
  )
  assert.match(rejected, /HDR/)
  assert.doesNotMatch(rejected, /Windows/)
  assert.notEqual(await c.evaluate('document.documentElement.dataset.nativeHdr'), '1')
  report.checks.push('SDR emulator rejects native HDR without hiding the retained SDR stage')
  await c.evaluate(`window.jap.setWindowMode('mini')`)
  await wait(
    `document.documentElement.dataset.windowMode==='mini'`,
    'Android enters actual system PiP'
  )
  await delay(1400)
  report.pip = await c.evaluate(
    `({w:innerWidth,h:innerHeight,controls:[...document.querySelectorAll('[data-mini-controls] button')].filter(b=>getComputedStyle(b).display!=='none'&&b.offsetHeight).map(b=>{const r=b.getBoundingClientRect();return{label:b.ariaLabel,x:r.x,y:r.y,w:r.width,h:r.height}})})`
  )
  for (const b of report.pip.controls) {
    assert.ok(
      b.x >= 0 && b.y >= 0 && b.x + b.w <= report.pip.w + 1 && b.y + b.h <= report.pip.h + 1,
      JSON.stringify(report.pip)
    )
  }
  assert.equal(report.pip.controls.length, 3)
  assert.ok(
    await c.evaluate(
      `document.querySelector('[data-mini-player] header').textContent.includes('Just A Player')`
    )
  )
  fs.writeFileSync(
    path.join(out, 'pip-activity.txt'),
    adb('shell', 'dumpsys', 'activity', 'activities')
  )
  shot('pip')
  report.checks.push('All three PiP controls fit inside the actual viewport; branding retained')
  foreground()
  await wait(
    `document.documentElement.dataset.windowMode==='normal'`,
    'PiP expands back to the main stage'
  )
  await c.evaluate(`__jap.useSettings.getState().update({keepScreenAwake:false})`)
  shot('touch-stage')
  assert.deepEqual(c.errors, [])
  report.status = 'passed'
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  report.lyricInput = await c.evaluate(
    '({events:window.__lyricTouchQA,viewport:[innerWidth,innerHeight,devicePixelRatio,visualViewport?.scale],dragging:window.__japLyrics?.dragging,interactive:window.__japLyrics?.interactive})'
  ).catch(() => null)
  shot('failure')
  throw error
} finally {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  await c
    .evaluate(
      `__jap.useSettings.getState().update({keepScreenAwake:false});if(__jap.usePlayer.getState().state==='playing')__jap.usePlayer.getState().togglePause()`
    )
    .catch(() => {})
  c.close()
}
