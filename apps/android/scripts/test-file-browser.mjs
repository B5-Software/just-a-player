import assert from 'node:assert/strict'
import { mkdirSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { adb,adbBytes,connect,delay } from './emulator-cdp.mjs'
const result=resolve(import.meta.dirname,'../test-results/file-browser')
mkdirSync(result,{recursive:true})
const c=await connect()
let originalLanguage
let originalScale
const oldSize = /Override size: (\d+x\d+)/.exec(adb('shell','wm','size'))?.[1] ?? 'reset'
const wait=async expression=>{for(let i=0;i<100;i++){if(await c.evaluate(expression))return;await delay(100)}throw Error('Timeout '+expression)}
try{
 await wait('!!window.__jap&&__jap.usePlayer.getState().connected')
 originalLanguage=await c.evaluate(`__jap.useSettings.getState().language`)
 originalScale=await c.evaluate(`__jap.useSettings.getState().androidUiScale`)
 await c.evaluate(`__jap.useSettings.getState().update({language:'en',androidUiScale:1,autoScan:false,onboardingComplete:true,autoHideControls:false});__jap.useUi.getState().setOnboardingOpen(false);true`)
 const sizes=[[960,360],[1280,720],[740,320]],report=[]
 for(const [width,height] of sizes){
  adb('shell','wm','size',`${width}x${height}`)
  await delay(800)
  // Resizing and the native viewport event are asynchronous. All three test
  // surfaces use the app's 480-unit landscape height at the default UI scale.
  await wait(`Math.abs(innerHeight-480)<2`)
  await c.evaluate(`window.__pick=window.jap.openAudioFiles();true`)
  await wait(`!!document.querySelector('[role="dialog"]')`)
  await delay(350)
  const metrics=await c.evaluate(`(()=>{const d=document.querySelector('[role="dialog"]'),f=d.querySelector('footer'),b=d.querySelector('.file-browser-body'),buttons=[...f.querySelectorAll('button')],rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};return{viewport:[innerWidth,innerHeight],dialog:rect(d),footer:rect(f),body:rect(b),buttons:buttons.map(rect),text:d.innerText}})()`)
  writeFileSync(join(result,`${width}x${height}.json`),JSON.stringify(metrics,null,2))
  writeFileSync(join(result,`${width}x${height}.png`),adbBytes('exec-out','screencap','-p'))
  assert(metrics.dialog.x>=-1&&metrics.dialog.y>=-1,JSON.stringify(metrics))
  assert(metrics.dialog.right<=metrics.viewport[0]+1&&metrics.dialog.bottom<=metrics.viewport[1]+1,JSON.stringify(metrics))
  assert(metrics.body.height>=60,'file list must have useful height: '+JSON.stringify(metrics))
  assert(metrics.buttons.every(b=>b.bottom<=metrics.viewport[1]+1&&b.height>=32),'footer controls must fit')
  assert(metrics.footer.y>=metrics.body.bottom-1,'file list must not cover footer')
  assert(!metrics.text.includes('选择音频'),'English file browser')
  report.push(metrics)
  await c.evaluate(`document.querySelector('[role="dialog"] header button').click();true`)
  await wait(`!document.querySelector('[role="dialog"]')`)
 }
 assert.deepEqual(c.errors,[])
 writeFileSync(join(result,'report.json'),JSON.stringify({passed:true,report},null,2))
 console.log('Android file browser passed: landscape sizes, fixed footer, usable file list, English labels; '+result)
}finally{
 adb('shell','wm','size',oldSize)
 if(originalLanguage)await c.evaluate(`__jap.useSettings.getState().update({language:${JSON.stringify(originalLanguage)},androidUiScale:${JSON.stringify(originalScale)}});true`).catch(()=>{})
 c.close()
}
