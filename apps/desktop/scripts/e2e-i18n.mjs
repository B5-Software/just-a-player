import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { wave } from '../../../scripts/fixtures/pcm.mjs'
import { graphicsArgs } from './e2e-graphics.mjs'
const cwd=resolve(import.meta.dirname,'..'),data=join(cwd,'test-results',`i18n-${Date.now()}`)
mkdirSync(data,{recursive:true})
const path=join(data,'播放.wav');writeFileSync(path,wave({seconds:30}))
const app=await electron.launch({executablePath:electronPath,cwd,args:['.',...graphicsArgs],env:{...process.env,JAP_E2E:'i18n',JAP_E2E_LOCALE:'fr-FR',JAP_E2E_USERDATA:data}})
try{
 const page=await app.firstWindow(),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.waitForFunction(()=>window.__jap?.usePlayer.getState().connected&&window.__jap.useLibrary.getState().loaded)
 await page.evaluate(async path=>{const j=window.__jap;j.useSettings.getState().update({autoScan:false,autoHideControls:false,onboardingComplete:true});j.useUi.getState().setOnboardingOpen(false);j.usePlayer.getState().setOutput({api:'null'});await j.addAudioPaths([path]);j.usePlayer.getState().play(path)},path)
 await page.waitForFunction(()=>window.__jap.usePlayer.getState().position.ms>200)
 assert.equal(await page.locator('html').getAttribute('lang'),'en')
 await page.getByRole('button',{name:'Settings',exact:true}).click()
 await page.getByRole('combobox',{name:'Language',exact:true}).waitFor()
 assert.equal(await page.locator('[data-now-playing] h1').textContent(),'播放')
 const pid=JSON.parse(readFileSync(join(data,'audio-service.json'))).pid
 await page.getByRole('combobox',{name:'Language',exact:true}).click()
 await page.getByRole('option',{name:'简体中文',exact:true}).click()
 await page.getByRole('combobox',{name:'语言',exact:true}).waitFor()
 assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN')
 await page.getByRole('combobox',{name:'语言',exact:true}).click()
 await page.getByRole('option',{name:'English',exact:true}).click()
 await page.getByRole('combobox',{name:'Language',exact:true}).waitFor()
 for(const panel of ['appearance','lyrics','dsp','output','quality','video','playlist','signal']){
   await page.evaluate(panel=>window.__jap.useUi.setState({panel}),panel)
   await page.locator(`[data-panel-root="${panel}"]`).waitFor()
   await page.waitForTimeout(130)
   const text=await page.locator(`[data-panel-root="${panel}"]`).innerText()
   writeFileSync(join(data,panel+'.txt'),text)
 }
 await page.evaluate(()=>window.__jap.useUi.setState({panel:null}))
 await page.getByRole('button',{name:'Open file',exact:true}).click()
 await page.getByRole('dialog',{name:'Choose audio files',exact:true}).waitFor()
 const computer=await page.evaluate(()=>window.jap.browseFiles('jap://computer'))
 const driveRoot=computer.entries?.find(entry=>/^[a-z]:\\$/i.test(entry.path))?.path
 if(process.platform==='win32'){
   assert.equal(computer.virtual,true)
   assert(driveRoot,'Windows must expose at least one logical drive')
   const drive=await page.evaluate(path=>window.jap.browseFiles(path),driveRoot.slice(0,2))
   assert.equal(drive.path,driveRoot);assert.equal(drive.parent,'jap://computer')
 }
 await page.getByRole('button',{name:'Close dialog',exact:true}).click()
  if(process.platform==='win32'){
    await page.evaluate(()=>{window.__folder=window.jap.openFolders();return true})
    const folder=page.getByRole('dialog')
    await folder.waitFor()
    await page.getByLabel('Folder path',{exact:true}).fill(driveRoot.slice(0,2))
    await page.getByLabel('Folder path',{exact:true}).press('Enter')
    await page.getByRole('button',{name:'Choose folder',exact:true}).click()
    assert.deepEqual(await page.evaluate(()=>window.__folder),[driveRoot])
  }
 await page.waitForFunction(()=>window.__jap.usePlayer.getState().state==='playing'&&window.__jap.usePlayer.getState().position.ms>1000)
 assert.equal(JSON.parse(readFileSync(join(data,'audio-service.json'))).pid,pid)
 assert.deepEqual(errors,[])
 await page.screenshot({path:join(data,'english.png')})
 console.log('i18n passed: system fallback, live language change, untouched metadata, panel coverage, English picker, Windows drives; '+data)
}finally{await app.close()}
