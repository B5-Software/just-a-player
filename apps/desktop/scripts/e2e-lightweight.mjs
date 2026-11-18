import assert from 'node:assert/strict'
import { _electron as electron, chromium } from 'playwright-core'
import electronPath from 'electron'
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wave } from '../../../scripts/fixtures/pcm.mjs'
import { graphicsArgs } from './e2e-graphics.mjs'
import { connect } from 'node:net'
const cwd = fileURLToPath(new URL('..', import.meta.url))
const packaged = process.argv.includes('--packaged')
const liveClient = process.argv.includes('--external') && process.argv.includes('--live-client')
const stopDevServer = !packaged && !liveClient
const executable = packaged
  ? join(
      cwd,
      'release',
      process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked',
      'Just A Player.exe'
    )
  : electronPath
const root = resolve(cwd, '../..'),
  data = join(cwd, 'test-results', `light-handoff-${Date.now()}`)
mkdirSync(data, { recursive: true })
const path = join(data, '交接测试.wav')
writeFileSync(path, wave({ seconds: 60 }))
let app
let devServer
let observer
let returnedBrowser
const requests = new Map()
let requestId=900000
const externalRequest = action => new Promise((resolve,reject)=>{
  const id=requestId++,timer=setTimeout(()=>{requests.delete(id);reject(Error('External cleanup timed out'))},15000)
  requests.set(id,value=>{clearTimeout(timer);value.error?reject(Error(value.error)):resolve(value.state)})
  observer.write(JSON.stringify({kind:'external',id,action})+'\n')
})
const transitions = []
let observing = false, position = 0
try {
  const env = { ...process.env, JAP_E2E: 'lightweight', JAP_E2E_USERDATA: data }
  delete env.ELECTRON_RENDERER_URL
  if (stopDevServer) {
    const { preview } = await import('vite')
    devServer = await preview({
      configFile: false,
      root: cwd,
      build: { outDir: 'out/renderer' },
      preview: { host: '127.0.0.1', port: 0 },
    })
    env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${devServer.httpServer.address().port}/?e2e=1`
  }
  app = await electron.launch({
    executablePath: executable,
    cwd,
    args: [...(packaged ? [] : ['.']), ...graphicsArgs],
    env,
  })
  const page = await app.firstWindow()
  await page.waitForFunction(
    () =>
      window.__jap?.usePlayer.getState().connected &&
      window.__jap.useLibrary.getState().loaded
  )
  const descriptor = JSON.parse(readFileSync(join(data,'audio-service.json'),'utf8'))
  observer = connect({host:'127.0.0.1',port:descriptor.port})
  observer.setEncoding('utf8')
  let buffer=''
  observer.on('data',bytes=>{
    buffer+=bytes
    for(let end;(end=buffer.indexOf('\n'))>=0;){
      const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1)
      if(value.kind==='externalResult'){const done=requests.get(value.id);requests.delete(value.id);done?.(value)}
      if(value.kind==='event'){
        if(value.event.type==='position')position=value.event.positionMs
        if(observing && ['state','trackChanged','signalPath'].includes(value.event.type))transitions.push(value.event)
      }
    }
  })
  await new Promise((resolve,reject)=>{observer.once('connect',resolve);observer.once('error',reject)})
  observer.write(JSON.stringify({kind:'hello',token:descriptor.token})+'\n')
  await page.waitForTimeout(200)
  await page.evaluate(async ({path,liveClient}) => {
    const j = window.__jap
    j.useUi.getState().setOnboardingOpen(false)
    j.useSettings
      .getState()
      .update({ autoScan: false, autoHideControls: false })
    j.usePlayer.getState().setOutput({ api: 'null' })
    j.usePlayer.getState().setVolume(0.17)
    await j.addAudioPaths([path])
    if(!liveClient)j.usePlayer.getState().play(path)
  }, {path,liveClient})
  if(liveClient){
    await page.evaluate(async()=>{
      const engine=window.__jap.engine
      await engine.external('connect',undefined,true)
      await engine.external('route')
      await engine.external('resume')
    })
  }
  await page.waitForFunction(
    () =>
      window.__jap.usePlayer.getState().state === 'playing' &&
      window.__jap.usePlayer.getState().position.ms > 600
  )
  await page.evaluate(() => window.__jap.useUi.setState({ panel: 'settings' }))
  observing=true
  const exited = new Promise((resolve) => app.process().once('exit', resolve))
  void page
    .getByRole('switch', { name: '轻量模式', exact: true })
    .click({ timeout: 10000, noWaitAfter: true })
    .catch(() => {})
  const until = async (predicate, label) => {
    const end = Date.now() + 40000
    let state
    while (Date.now() < end) {
      try {
        state = JSON.parse(
          readFileSync(join(data, 'native-report.json'), 'utf8')
        )
        if (predicate(state)) return state
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    throw Error(label + ': ' + JSON.stringify(state))
  }
  const input = async (value) => {
    writeFileSync(join(data, 'native-input.tmp'), JSON.stringify(value))
    renameSync(join(data, 'native-input.tmp'), join(data, 'native-input.json'))
    await new Promise((r) => setTimeout(r, 300))
  }
  const state = await until(
    (s) =>
      s.renderer === 'egui-native' && s.state === 'playing' && s.position > 500 && (!liveClient || (s.external.phase==='routing'&&s.hasMediaCover)),
    'Native window'
  )
  assert.equal(state.webview, false)
  assert(Math.abs(state.volume - 0.17) < 1e-5)
  assert(state.library.lists.some((l) => l.items.some((i) => i.path === path)))
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('Electron did not exit')), 10000)
    ),
  ])
  if (devServer) {
    assert.equal(page.url(), env.ELECTRON_RENDERER_URL)
    await devServer.close()
    devServer = undefined
  }
  observing=false
  assert(!transitions.some(e=>e.type==='state'&&e.state!=='playing'),'mode switch must not pause/stop the engine')
  assert(!transitions.some(e=>e.type==='trackChanged'),'mode switch must not reopen the source')
  assert.equal(JSON.parse(readFileSync(join(data,'audio-service.json'),'utf8')).pid,descriptor.pid)
  assert.equal(
    JSON.parse(readFileSync(join(data, 'lightweight-mode.json'), 'utf8'))
      .enabled,
    true
  )
  await input({ type: 'command', command: 'pause' })
  await until((s) => s.state === 'paused', 'Pause native')
  await input({ type: 'volume', gain: 0.07 })
  await until((s) => Math.abs(s.volume - 0.07) < 1e-5, 'Change native volume')
  await input({ type: 'screenshot' })
  await new Promise((r) => setTimeout(r, 500))
  await input({type:'command',command:'play'})
  await until(s=>s.state==='playing','Resume native before return')
  const beforeReturn=position
  transitions.length=0;observing=true
  await input({ type: 'full' })
  const returnDeadline = Date.now() + 30000
  while (!returnedBrowser && Date.now() < returnDeadline) {
    try {
      const port = Number(readFileSync(join(data, 'DevToolsActivePort'), 'utf8').split('\n')[0])
      returnedBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 })
    } catch { await new Promise(resolve => setTimeout(resolve, 150)) }
  }
  assert(returnedBrowser, 'Returned full interface must start its browser process')
  const context = returnedBrowser.contexts()[0]
  const returnedPage = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15000 })
  await returnedPage.waitForURL(url => url.protocol === 'file:' && url.pathname.endsWith('/renderer/index.html'), { timeout: 15000 })
  await returnedPage.waitForFunction(() => window.__jap?.usePlayer.getState().connected && window.__jap.usePlayer.getState().state === 'playing')
  await returnedPage.locator('[data-now-playing] h1').waitFor({ state: 'visible' })
  assert(Math.abs(await returnedPage.evaluate(() => window.__jap.usePlayer.getState().volume) - 0.07) < 1e-5, 'Full UI must keep the native volume')
  if (liveClient) await returnedPage.waitForFunction(() => window.__jap.useExternal.getState().phase === 'routing' && !!window.__jap.useCover.getState().art)
  await returnedPage.screenshot({ path: join(data, 'returned-full.png') })
  assert.equal(
    JSON.parse(readFileSync(join(data, 'lightweight-mode.json'), 'utf8'))
      .enabled,
    false
  )
  observing=false
  assert(position>beforeReturn,'shared playback must advance while returning to full mode')
  assert(!transitions.some(e=>e.type==='state'&&e.state!=='playing'))
  assert(!transitions.some(e=>e.type==='trackChanged'))
  assert.equal(JSON.parse(readFileSync(join(data,'audio-service.json'),'utf8')).pid,descriptor.pid)
  const saved = JSON.parse(readFileSync(join(data, 'lightweight.json'), 'utf8'))
  if(!liveClient)assert(saved.last.positionMs > 500)
  writeFileSync(
    join(data, 'passed.json'),
    JSON.stringify(
      {
        passed: true,
        renderer: state.renderer,
        liveClient,
        stoppedDevServer: stopDevServer,
        webview: false,
        checks: [
          'Electron exits after native Rust window opens',
          'playing position, volume and session queue transferred',
          'native pause and gain',
          'full mode requested with saved state',
          'same audio-host PID in both directions; no pause, stop or source reopen',
          'returned full interface is visible and controls the existing session',
        ],
      },
      null,
      2
    )
  )
  console.log('Desktop native handoff passed: ' + data)
} catch (error) {
  console.error(error)
  throw error
} finally {
  if(liveClient&&observer&&!observer.destroyed){
    for(const action of ['pause','disconnect'])try{await externalRequest(action)}catch(error){console.error('Client cleanup:',String(error))}
  }
  observer?.destroy()
  await returnedBrowser?.close().catch(() => {})
  if (app?.process().exitCode === null) app.process().kill()
  await devServer?.close()
  // Only QA instances with this exact isolated user-data directory belong to us.
  if (process.platform === 'win32') {
    const { spawnSync } = await import('node:child_process')
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${data.replaceAll("'", "''")}*' -and ($_.Name -eq 'electron.exe' -or $_.Name -eq 'Just A Player.exe' -or $_.Name -eq 'jap-lightweight.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { windowsHide: true }
    )
  }
}
