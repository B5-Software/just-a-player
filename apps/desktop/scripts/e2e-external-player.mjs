// Opt-in live-client integration. Terminal/API only: no input automation,
// screenshots, physical Rust output, credentials or captured song data.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

if (process.platform !== 'win32' || !process.argv.includes('--live-client')) {
  console.log('Opt in on Windows with --live-client; start NetEase with a selected test track first.')
  process.exit(0)
}
const appDir = resolve(fileURLToPath(import.meta.url), '../..')
const resultDir = join(appDir, 'test-results/external-integration')
mkdirSync(resultDir, { recursive: true })
const appArgument = process.argv.indexOf('--app')
const packagedApp = appArgument < 0 ? null : process.argv[appArgument + 1]
if (appArgument >= 0 && !packagedApp) throw new Error('--app requires a packaged executable path')
const app = await electron.launch({
  executablePath: packagedApp ? resolve(packagedApp) : electronPath,
  args: packagedApp ? [] : [join(appDir, 'out/main/index.js')],
  cwd: appDir,
  env: { ...process.env, JAP_E2E: '1', JAP_E2E_HIDDEN: '1', JAP_E2E_USERDATA: mkdtempSync(join(tmpdir(), 'jap-external-e2e-')) },
})
const page = await app.firstWindow()
page.on('console', message => { if (message.type() === 'log' && message.text().startsWith('{"phase"')) console.log(message.text()) })
const report = { force: true, packaged: !!packagedApp, output: 'null', checks: {} }
let failed = false
const wait = (fn, timeout = 20000) => page.waitForFunction(fn, undefined, { timeout })
const smtc = join(resultDir, 'smtc.ps1')
writeFileSync(smtc, `param([string]$Action='read')
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
function Await($op,$type) { $m=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 } | Select-Object -First 1; $t=$m.MakeGenericMethod($type).Invoke($null,@($op)); if(!$t.Wait(5000)){throw 'SMTC timeout'}; $t.Result }
$manager=Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session=$manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -eq 'B5Software.JustAPlayer' } | Select-Object -First 1
if(!$session){throw 'Native session not found'}
if($Action -eq 'pause'){$null=Await ($session.TryPauseAsync()) ([bool])}
if($Action -eq 'play'){$null=Await ($session.TryPlayAsync()) ([bool])}
$props=Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
@{title=$props.Title; artist=$props.Artist; thumbnail=($null -ne $props.Thumbnail)} | ConvertTo-Json -Compress
`)
const system = action => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', smtc, '-Action', action], { windowsHide: true, encoding: 'utf8', timeout: 12000 }).trim())
try {
  await wait(() => window.__jap?.usePlayer.getState().connected)
  await page.evaluate(() => {
    const j = window.__jap
    let phase = ''
    j.engine.onExternal(state => { if (state.phase !== phase) { phase = state.phase; console.log(JSON.stringify({ phase, message: state.message })) } })
    j.useSettings.getState().update({ autoScan: false, wallpaperEnabled: false, renderFps: 15, lyricsMode: '2d' })
    j.usePlayer.getState().setOutput({ api: 'null', deviceId: null, bufferMs: 80, dsdMode: 'pcm' })
    j.usePlayer.getState().setVolume(0.2)
  })
  await page.evaluate(() => window.__jap.engine.external('connect', undefined, true))
  await wait(() => window.__jap.useExternal.getState().snapshot?.track.id)
  const original = await page.evaluate(() => {
    const s=window.__jap.useExternal.getState().snapshot
    return {id:s.track.id,position:s.positionMs,mode:s.mode,index:s.queue?.items.findIndex(item=>item.id===s.track.id)??-1}
  })
  await wait(() => window.__jap.useExternal.getState().snapshot?.devices?.totalDevices.some(g => g.devices.some(d => d.name === 'Just A Player HiFi Bridge (Black Hole)')))
  await page.evaluate(() => window.__jap.engine.external('route'))
  if (await page.evaluate(() => window.__jap.useExternal.getState().snapshot.state !== 'playing')) {
    await page.evaluate(() => window.__jap.engine.external('resume'))
  }
  await wait(() => window.__jap.useExternal.getState().phase === 'routing' && window.__jap.useExternal.getState().audioPackets >= 8)
  await wait(() => window.__jap.usePlayer.getState().track?.path.startsWith('external://'))
  await wait(() => !!window.__jap.useCover.getState().art)
  const coverUrl=await page.evaluate(()=>window.__jap.useCover.getState().art.url)
  await page.waitForTimeout(1200)
  assert.equal(await page.evaluate(()=>window.__jap.useCover.getState().art.url),coverUrl,'unchanged cover must not reload on status polls')
  const state = await page.evaluate(() => {
    const j = window.__jap, p = j.usePlayer.getState(), e = j.useExternal.getState()
    return { title: p.track.title, sourceTitle: e.snapshot.track.title, artist: p.track.artist, sourceArtist: e.snapshot.track.artist, cover: !!j.useCover.getState().art, lyrics: !!j.useLyrics.getState().text, device: e.snapshot.devices.currentDevice.name, packets: e.audioPackets, nullBytes: e.nullBytes }
  })
  assert.equal(state.title, state.sourceTitle)
  assert.equal(state.artist, state.sourceArtist)
  assert.equal(state.device, 'Just A Player HiFi Bridge (Black Hole)')
  assert(BigInt(state.nullBytes) > 0n)
  report.checks.routingMetadataCover = { ...state, title: undefined, sourceTitle: undefined, artist: undefined, sourceArtist: undefined }
  if (process.argv.includes('--require-lyrics')) {
    await wait(() => !!window.__jap.useLyrics.getState().text)
    report.checks.lyrics = true
  }
  const media = system('read')
  assert.equal(media.title, state.title)
  assert.equal(media.artist, state.artist)
  assert(media.thumbnail)
  system('pause')
  await wait(() => window.__jap.useExternal.getState().snapshot?.state === 'paused')
  system('play')
  await wait(() => window.__jap.useExternal.getState().snapshot?.state === 'playing')
  report.checks.systemMediaAndControls = true
  await page.evaluate(() => window.__jap.usePlayer.getState().togglePause())
  await wait(() => window.__jap.useExternal.getState().snapshot?.state === 'paused' && window.__jap.usePlayer.getState().state === 'paused')
  await new Promise(resolve => setTimeout(resolve, 3000))
  await page.evaluate(() => window.__jap.usePlayer.getState().togglePause())
  await wait(() => window.__jap.useExternal.getState().snapshot?.state === 'playing' && window.__jap.usePlayer.getState().state === 'playing')
  report.checks.pauseResumeAfterIdle = true
  await page.evaluate(() => window.__jap.usePlayer.getState().seek(15000))
  await wait(() => Math.abs(window.__jap.usePlayer.getState().position.ms - 15000) < 2500 && Math.abs(window.__jap.useExternal.getState().snapshot?.positionMs - 15000) < 2500)
  report.checks.nativeSeek = true
  const before = await page.evaluate(() => ({ resets: window.__jap.usePlayer.getState().bufferResets, packets: window.__jap.useExternal.getState().audioPackets }))
  await page.evaluate(() => window.__jap.usePlayer.getState().resetBuffer())
  await page.waitForFunction(b => window.__jap.usePlayer.getState().bufferResets > b.resets && window.__jap.useExternal.getState().audioPackets > b.packets, before)
  report.checks.resetBuffer = true
  if(process.argv.includes('--queue')) {
    for(const [action,mode] of [['repeatOne','one'],['shuffleOn','shuffle'],['repeatAll','all']]) {
      await page.evaluate(action=>window.__jap.engine.external(action),action)
      await page.waitForFunction(mode=>window.__jap.useExternal.getState().snapshot.mode===mode,mode)
    }
    report.checks.delegatedRepeatShuffle=true
    const target=await page.evaluate(()=>{const s=window.__jap.useExternal.getState().snapshot;return s.queue.items.map((track,index)=>({track,index})).find(item=>item.track.id!==s.track.id)})
    assert(target,'Client queue must include another track for this opt-in test')
    await page.evaluate(()=>window.__jap.useUi.setState({panel:'playlist'}))
    const queue=page.getByRole('list',{name:'网易云播放队列'})
    await queue.getByRole('listitem').filter({hasText:target.track.title}).first().click()
    await page.waitForFunction(id=>window.__jap.usePlayer.getState().track?.path===`external://netease/${encodeURIComponent(id)}`&&window.__jap.usePlayer.getState().state==='playing',target.track.id,{timeout:30000})
    report.checks.clientQueueSelection=true
    const duration=target.track.durationMs
    assert(duration>5000)
    await page.evaluate(ms=>window.__jap.engine.external('seek',ms),duration-1200)
    await page.waitForFunction(id=>{const j=window.__jap,s=j.useExternal.getState();return s.snapshot.track.id!==id&&s.phase==='routing'&&j.usePlayer.getState().track?.path===`external://netease/${encodeURIComponent(s.snapshot.track.id)}`&&j.usePlayer.getState().state==='playing'&&j.usePlayer.getState().position.ms>100},target.track.id,{timeout:40000})
    report.checks.naturalNextWithoutLocalConflict=true
    if(original.index>=0){
      await page.evaluate(index=>window.__jap.engine.external('playIndex',index),original.index)
      await page.waitForFunction(id=>window.__jap.useExternal.getState().snapshot.track.id===id,original.id)
    }
    const restoreMode={off:'repeatOff',one:'repeatOne',shuffle:'shuffleOn',all:'repeatAll'}[original.mode]
    if(restoreMode)await page.evaluate(action=>window.__jap.engine.external(action),restoreMode)
  }
  await page.evaluate(() => window.__jap.engine.external('pause'))
  await page.evaluate(() => window.__jap.engine.external('disconnect'))
  const cleanup = await page.evaluate(() => window.__jap.useExternal.getState())
  assert.equal(cleanup.phase, 'disconnected', cleanup.message)
  report.checks.restoreOutput = cleanup.message.includes('已恢复')
  // Reconnect while genuinely paused, with no mouse/script event to wake CEF.
  await page.evaluate(() => window.__jap.engine.external('connect', undefined, true))
  await wait(() => window.__jap.useExternal.getState().phase === 'ready')
  report.checks.pausedReconnect = true
  await page.evaluate(() => window.__jap.engine.external('disconnect'))
} catch (error) {
  failed = true
  report.error = String(error)
  console.error(error)
  report.state = await page.evaluate(() => { const j=window.__jap,e=j.useExternal.getState(),p=j.usePlayer.getState(); return {phase:e.phase,message:e.message,packets:e.audioPackets,sourceState:e.snapshot?.state,sourcePosition:e.snapshot?.positionMs,playerState:p.state,error:p.error,cover:!!j.useCover.getState().art} }).catch(()=>null)
} finally {
  try { await page.evaluate(() => window.__jap.engine.external('disconnect')) } catch {}
  await app.close()
  writeFileSync(join(resultDir, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify(report, null, 2))
process.exitCode = failed ? 1 : 0
