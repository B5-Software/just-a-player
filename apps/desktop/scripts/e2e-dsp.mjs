// Terminal-driven UI/engine regression; no system input, DAC or screenshots.
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { wave } from '../../../scripts/fixtures/pcm.mjs'
import { graphicsArgs } from './e2e-graphics.mjs'
const cwd=resolve(import.meta.dirname,'..'),out=join(cwd,'test-results/dsp');mkdirSync(out,{recursive:true})
const path=join(out,'preset-test.wav');writeFileSync(path,wave({seconds:30}))
const app=await electron.launch({executablePath:electronPath,cwd,args:[join(cwd,'out/main/index.js'),'--no-sandbox',...graphicsArgs],env:{...process.env,JAP_E2E:'1',JAP_E2E_HIDDEN:'1',JAP_E2E_USERDATA:mkdtempSync(join(tmpdir(),'jap-dsp-'))}})
const page=await app.firstWindow(),report={presets:[],errors:[]}
page.on('pageerror',e=>report.errors.push(String(e)))
try{
 await page.waitForFunction(()=>window.__jap?.usePlayer.getState().connected)
 await page.evaluate(path=>{const j=window.__jap;j.useQuality.getState().setAutomatic(false);j.usePlayer.getState().setOutput({api:'null',deviceId:null,dsdMode:'pcm'});j.useDsp.getState().update({enabled:false});j.usePlayer.getState().play(path);j.useUi.getState().togglePanel('dsp')},path)
 await page.waitForFunction(()=>!!document.querySelector('[role="combobox"][aria-label="音效预置"]'))
 for(const name of ['温暖','人声','摇滚','爵士','清亮','耳机串音','平直']){
  await page.evaluate(()=>document.querySelector('[role="combobox"][aria-label="音效预置"]').click())
  await page.waitForFunction(()=>!!document.querySelector('[role="listbox"][aria-label="音效预置"]'))
  await page.evaluate(name=>{const option=Array.from(document.querySelectorAll('[role="option"]')).find(o=>o.firstElementChild?.textContent===name);if(!option)throw Error('Preset option missing');option.click()},name)
  await page.waitForFunction(name=>{const j=window.__jap,c=j.useDsp.getState().config,s=document.querySelector('[role="combobox"][aria-label="音效预置"]');return c.enabled&&s?.textContent.includes(name)&&j.usePlayer.getState().signalPath?.nodes.some(n=>n.title==='DSP · 10 段 EQ')},name)
  const actual=await page.evaluate(()=>({config:window.__jap.useDsp.getState().config,saved:JSON.parse(localStorage.getItem('jap.dsp.v1'))}))
  assert.deepEqual(actual.config,actual.saved)
  if(name==='温暖'){assert.equal(actual.config.eqDb[0],3);assert.equal(actual.config.preampDb,-5)}
  if(name==='耳机串音')assert.equal(actual.config.crossfeed,0.65)
  report.presets.push(name)
 }
 assert.deepEqual(report.errors,[])
}finally{await app.close();writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2))}
console.log(JSON.stringify(report,null,2))
