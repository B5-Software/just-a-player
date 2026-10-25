// Android/Harmony real native engine, full -> light -> full without a second player.
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const harmony = process.argv.includes('--harmony')
const host = await import(
  harmony
    ? '../apps/harmony/scripts/cdp.mjs'
    : '../apps/android/scripts/emulator-cdp.mjs'
)
if (!harmony) host.adb('shell', 'cmd', 'notification', 'set_dnd', 'none')
let c = await host.connect()
const checks = []
const folder = new URL(
  harmony ? '../apps/harmony/test-results/' : '../apps/android/test-results/',
  import.meta.url
)
mkdirSync(folder, { recursive: true })
const wait = async (expression) => {
  const end = Date.now() + 25000
  while (Date.now() < end) {
    try {
      if (await c.evaluate(expression)) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('Timeout: ' + expression)
}
try {
  if (harmony && !(await c.evaluate("location.search.includes('e2e')"))) {
    await c.send('Page.navigate', {
      url: 'https://jap.localhost/index.html?e2e=1',
    })
  }
  await wait('!!window.__jap?.usePlayer.getState().connected')

  if (harmony && !(await c.evaluate('!!window.__jap')))
    await c.send('Page.navigate', {
      url: 'https://jap.localhost/index.html?e2e=1',
    })
  await wait(
    '!!window.__jap?.usePlayer.getState().connected && window.__jap.useLibrary.getState().loaded'
  )
  await c.evaluate(
    `(() => { const j=window.__jap;j.useSettings.getState().update({autoScan:false,autoHideControls:false,rememberPlaylist:false});j.useUi.getState().setOnboardingOpen(false);j.usePlayer.getState().setVolume(.05);j.usePlayer.getState().setOutput({api:'${harmony ? 'ohosShared' : 'androidShared'}',deviceId:null,dsdMode:'pcm'});let id=900000;const pending=new Map(),original=window.__androidEvent;window.__androidEvent=(key,v)=>{if(key==='rpc'&&pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(Error(v.error)):p.resolve(v.value)}else original(key,v)};window.__qaRpc=(method,payload)=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});(window.NativeAndroid||window.NativeHarmony).request(key,method,JSON.stringify(payload))});})()`
  )
  await c.evaluate(
    "window.__qaRpc('lightSave',{json:JSON.stringify({prefs:{meters:[],volume:.05}})})"
  )
  const { wave, WORD_LYRICS } = await import('./fixtures/pcm.mjs')
  let path
  if (harmony) {
    path = await c.evaluate(
      `window.__qaRpc('qaWrite',${JSON.stringify({ name: 'light-fixture.wav', data: wave({ seconds: 30 }).toString('base64') })})`
    )
    await c.evaluate(
      `window.__qaRpc('qaWrite',${JSON.stringify({ name: 'light-fixture.lrc', data: Buffer.from(WORD_LYRICS).toString('base64') })})`
    )
  } else {
    const app = 'org.b5_software.justaplayer.debug'
    host.adbInput(
      Buffer.from(wave({ seconds: 30 }).toString('base64') + '\n'),
      'shell',
      '-T',
      'run-as',
      app,
      'sh',
      '-c',
      "'base64 -d > files/light-fixture.wav'"
    )
    host.adbInput(
      Buffer.from(Buffer.from(WORD_LYRICS).toString('base64') + '\n'),
      'shell',
      '-T',
      'run-as',
      app,
      'sh',
      '-c',
      "'base64 -d > files/light-fixture.lrc'"
    )
    path = '/data/user/0/' + app + '/files/light-fixture.wav'
  }
  await c.evaluate(`window.__jap.addAudioPaths([${JSON.stringify(path)}])`)
  // Native file scanning canonicalizes Android's /data/user/0 alias. Start the
  // imported item through the same queue operation as a real list click.
  await c.evaluate(
    `(() => {const j=window.__jap,s=j.useLibrary.getState(),l=s.lists.find(l=>l.id===s.activeListId),i=l.items.find(i=>i.path.endsWith('/light-fixture.wav'));if(!i)throw Error('Imported fixture missing');j.playItem(l.id,i.id)})()`
  )
  await wait(
    "window.__jap.usePlayer.getState().state==='playing'&&window.__jap.usePlayer.getState().position.ms>300&&window.__jap.usePlayer.getState().track?.path.endsWith('/light-fixture.wav')"
  )
  path = await c.evaluate('window.__jap.usePlayer.getState().track.path')
  const position = await c.evaluate(
    'window.__jap.usePlayer.getState().position.ms'
  )
  await c.evaluate("window.__jap.useUi.setState({panel:'settings'})")
  await wait("!!document.querySelector('[role=switch][aria-label=轻量模式]')")
  if (!harmony)
    host.adb(
      'shell',
      'run-as',
      'org.b5_software.justaplayer.debug',
      'rm',
      '-f',
      'files/native-report.json'
    )
  void c
    .evaluate(
      "document.querySelector('[role=switch][aria-label=轻量模式]').click()"
    )
    .catch(() => {})
  await new Promise((r) => setTimeout(r, 350))
  c.close()
  c = null
  const native = async () => {
    if (!harmony) {
      // The debug View rewrites this file; ADB can observe its truncate/write gap.
      // Retry only incomplete JSON, so transport failures still fail the test.
      for (let attempt = 0; ; attempt++) {
        try {
          return JSON.parse(
            host.adb(
              'shell',
              'run-as',
              'org.b5_software.justaplayer.debug',
              'cat',
              'files/native-report.json'
            )
          )
        } catch (error) {
          if (!(error instanceof SyntaxError) || attempt >= 7) throw error
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
    }
    host.shell('uitest dumpLayout -p /data/local/tmp/jap-native-layout.json')
    const tree = JSON.parse(
      host.shell('cat /data/local/tmp/jap-native-layout.json')
    )
    const visit = (node) => {
      const a = node.attributes || {},
        description = a.description || ''
      if (description.includes('"renderer":"egui-native"')) {
        const state = JSON.parse(description),
          bounds = a.bounds.match(/-?\d+/g).map(Number)
        return {
          ...state,
          viewX: bounds[0],
          viewY: bounds[1],
          viewWidth: bounds[2] - bounds[0],
          viewHeight: bounds[3] - bounds[1],
        }
      }
      for (const child of node.children || []) {
        const value = visit(child)
        if (value) return value
      }
    }
    const state = visit(tree)
    if (!state)
      throw Error('Native Rust surface not found in ArkUI accessibility tree')
    return state
  }
  const until = async (predicate, label) => {
    const deadline = Date.now() + 30000
    let state, error
    while (Date.now() < deadline) {
      try {
        state = await native()
        if (predicate(state)) return state
      } catch (e) {
        error = e
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw Error(label + ': ' + JSON.stringify(state || String(error)))
  }
  const point = (state, id, fraction = 0.5) => {
    const r = state.controls[id]
    assert(r, 'Missing native control ' + id)
    return [
      Math.round(
        state.viewX +
          ((r[0] + r[2] * fraction) / state.viewport[0]) * state.viewWidth
      ),
      Math.round(
        state.viewY +
          ((r[1] + r[3] * 0.5) / state.viewport[1]) * state.viewHeight
      ),
    ]
  }
  const click = async (id, fraction = 0.5) => {
    const state = await native(),
      [x, y] = point(state, id, fraction)
    if (harmony) host.shell(`uitest uiInput click ${x} ${y}`)
    else host.adb('shell', 'input', 'tap', String(x), String(y))
    await new Promise((r) => setTimeout(r, 500))
  }
  let state = await until(
    (s) =>
      s.renderer === 'egui-native' &&
      s.state === 'playing' &&
      s.position > position,
    'Native playback'
  )
  assert.equal(state.webview, false)
  assert.equal(state.visual, false)
  assert.deepEqual(state.meters, [])
  assert(state.library.lists.some((l) => l.items.some((i) => i.path === path)))
  checks.push(
    'full -> real Rust/egui native view; shared engine, position and session queue preserved'
  )
  const before = state.volume
  await click('volume', 0.85)
  await new Promise((r) => setTimeout(r, 1000))
  assert(
    Math.abs((await native()).volume - before) < 1e-5,
    'Tap must not move gain'
  )
  const start = point(await native(), 'volume', before),
    end = point(await native(), 'volume', 0.3)
  if (harmony)
    host.shell(
      `uitest uiInput swipe ${start[0]} ${start[1]} ${end[0]} ${end[1]} 600`
    )
  else
    host.adb(
      'shell',
      'input',
      'swipe',
      ...start.map(String),
      ...end.map(String),
      '600'
    )
  state = await until(
    (s) => s.volume > before + 0.08 && s.volume < 0.5,
    'Deliberate native slider drag'
  )
  await new Promise((r) => setTimeout(r, 1200))
  state = await native()
  const gain = state.volume
  checks.push(
    'touch tap leaves slider unchanged; deliberate drag changes native gain'
  )
  await click('settings')
  await until((s) => !!s.controls['meter-vu'], 'Native settings')
  await click('meter-vu')
  await click('modal-close')
  state = await until(
    (s) => s.visual && s.analysisFrames > 2 && s.rms.some((v) => v > 0.005),
    'Native PCM VU'
  )
  assert.deepEqual(state.meters, ['vu'])
  checks.push('independent optional VU reads real native PCM')
  for (const id of ['play', 'next', 'previous', 'volume']) {
    const r = state.controls[id]
    assert(
      r && r[1] >= 0 && r[1] + r[3] <= state.viewport[1] + 1,
      'Transport fits: ' + id
    )
  }
  checks.push('native landscape viewport keeps transport controls visible')
  if (harmony) {
    host.shell('snapshot_display -f /data/local/tmp/jap-native.png')
    const { execFileSync } = await import('node:child_process')
    execFileSync(
      process.env.HDC_PATH ||
        'C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe',
      [
        '-t',
        host.serial,
        'file',
        'recv',
        '/data/local/tmp/jap-native.png',
        fileURLToPath(new URL('lightweight.png', folder)),
      ],
      { windowsHide: true }
    )
  } else
    writeFileSync(
      new URL('lightweight.png', folder),
      host.adbBytes('exec-out', 'screencap', '-p')
    )
  await click('play')
  state = await until((s) => s.state === 'paused' && !s.visual, 'Native pause')
  await new Promise((r) => setTimeout(r, 1000))
  const frames = (await native()).analysisFrames
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal((await native()).analysisFrames, frames)
  checks.push('pause stops native analysis')
  await click('full')
  const deadline = Date.now() + 40000
  while (!c && Date.now() < deadline) {
    try {
      c = await host.connect()
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  assert(c, 'Full interface did not return')
  if (harmony && !(await c.evaluate('location.search.includes("e2e")')))
    await c.send('Page.navigate', {
      url: 'https://jap.localhost/index.html?e2e=1',
    })
  await wait(
    '!!window.__jap?.usePlayer.getState().connected&&!!window.__jap.useLibrary.getState().playback'
  )
  const result = await c.evaluate(
    `({track:window.__jap.usePlayer.getState().track?.path,state:window.__jap.usePlayer.getState().state,volume:window.__jap.usePlayer.getState().volume,library:window.__jap.useLibrary.getState()})`
  )
  assert.equal(result.track, path)
  assert.equal(result.state, 'paused')
  assert(Math.abs(result.volume - gain) < 0.001, JSON.stringify(result))
  const playback = result.library.playback
  assert(
    result.library.lists
      .find((l) => l.id === playback.listId)
      ?.items.some(
        (i) => i.id === playback.order[playback.index] && i.path === path
      )
  )
  checks.push('native -> full preserves paused track, queue and edited volume')
  if (!harmony) {
    host.adb(
      'shell',
      'run-as',
      'org.b5_software.justaplayer.debug',
      'rm',
      '-f',
      'files/native-report.json'
    )
    await c.evaluate("window.__jap.useUi.setState({panel:'settings'})")
    await wait("!!document.querySelector('[role=switch][aria-label=轻量模式]')")
    void c
      .evaluate(
        "document.querySelector('[role=switch][aria-label=轻量模式]').click()"
      )
      .catch(() => {})
    await new Promise((r) => setTimeout(r, 350))
    c.close()
    c = null
    await until((s) => s.renderer === 'egui-native', 'Native before restart')
    host.adb('shell', 'am', 'force-stop', 'org.b5_software.justaplayer.debug')
    host.adb(
      'shell',
      'run-as',
      'org.b5_software.justaplayer.debug',
      'rm',
      '-f',
      'files/native-report.json'
    )
    host.adb(
      'shell',
      'am',
      'start',
      '-n',
      'org.b5_software.justaplayer.debug/org.b5_software.justaplayer.MainActivity',
      '--ez',
      'e2e',
      'true'
    )
    const cold = await until(
      (s) => s.renderer === 'egui-native',
      'Native cold start'
    )
    const pid = host.adb('shell', 'pidof', 'org.b5_software.justaplayer.debug')
    assert(
      !host
        .adb('shell', 'cat', '/proc/net/unix')
        .includes('webview_devtools_remote_' + pid),
      'Cold native startup must not initialize a WebView'
    )
    assert(
      cold.library.lists.every((l) => !l.items.length),
      'Playlist persistence is disabled'
    )
    checks.push(
      'native cold start creates no WebView; disabled playlist persistence is respected'
    )
    await click('full')
    c = await host.connect()
    await wait('!!window.__jap?.usePlayer.getState().connected')
  }
  writeFileSync(
    new URL('lightweight-report.json', folder),
    JSON.stringify({ passed: true, checks, native: state }, null, 2)
  )
  console.log(
    JSON.stringify(
      { passed: true, platform: harmony ? 'HarmonyOS' : 'Android', checks },
      null,
      2
    )
  )
} catch (error) {
  writeFileSync(new URL('lightweight-failure.txt', folder), error.stack)
  throw error
} finally {
  c?.close()
}
