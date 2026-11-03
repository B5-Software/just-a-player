// Opt-in live NetEase test. Native Rust window stays hidden; Rust uses null
// output, and the client is routed to the black hole before it is resumed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const root=resolve(import.meta.dirname,'../..'), desktop=join(root,'apps/desktop')
if(process.platform!=='win32'||!process.argv.includes('--live-client')){console.log('Use --live-client on Windows with NetEase already started.');process.exit(0)}
const require=createRequire(join(desktop,'package.json')), electron=require('electron')
const folder=join(desktop,'test-results','native-external-'+Date.now());mkdirSync(folder,{recursive:true})
const handoff=join(folder,'start.json');writeFileSync(handoff,JSON.stringify({volume:0.2,state:'stopped',output:{api:'null',deviceId:null,bufferMs:80,dsdMode:'pcm'}}))
const packed=process.argv.includes('--packaged'),resources=join(desktop,packed?'release/win-unpacked/resources':'build')
const binary=packed?join(resources,'lightweight/jap-lightweight.exe'):join(root,'target/debug/jap-lightweight.exe')
const child=spawn(binary,['--data-dir',folder,'--resources',resources,'--return-app',packed?join(desktop,'release/win-unpacked/Just A Player.exe'):electron,...(packed?[]:['--return-entry',join(desktop,'out/main/index.js')]),'--handoff',handoff,'--qa','--qa-hidden'],{windowsHide:true,stdio:['ignore','pipe','pipe']})
let logs='';child.stderr.on('data',b=>logs+=b);child.stdout.on('data',b=>logs+=b)
const read=()=>{try{return JSON.parse(readFileSync(join(folder,'native-report.json'),'utf8'))}catch{return null}}
async function wait(test,ms=30000){const until=Date.now()+ms;while(Date.now()<until){const s=read();if(s&&test(s))return s;if(s?.error)throw Error(s.error);if(child.exitCode!==null)throw Error('Native exit: '+logs);await new Promise(r=>setTimeout(r,100))}throw Error('Native timeout: '+test+' '+JSON.stringify(read())+' '+logs)}
async function send(value){const path=join(folder,'native-input.json');const end=Date.now()+5000;while(existsSync(path)&&Date.now()<end)await new Promise(r=>setTimeout(r,30));writeFileSync(path+'.pending',JSON.stringify(value));renameSync(path+'.pending',path)}
const report={packaged:packed,checks:{}};let failed=false
try{
 await wait(s=>s.external.available);assert.equal(read().webview,false)
 await send({type:'external-connect',force:true});await wait(s=>s.external.phase==='ready')
 await send({type:'external-action',action:'route'});await wait(s=>s.external.device==='Just A Player HiFi Bridge (Black Hole)')
 await send({type:'external-action',action:'resume'});const s=await wait(s=>s.external.phase==='routing'&&s.external.audioPackets>8&&s.hasDecodedCover&&s.hasMediaCover&&s.lyricLines>0)
 assert(s.current.path.startsWith('external://'));assert.equal(s.renderResourcesResident,false)
 report.checks.nativeRouting={codec:s.current.codec,packets:s.external.audioPackets,cover:s.hasDecodedCover,systemCover:s.hasMediaCover,lyricLines:s.lyricLines,webview:s.webview}
 await send({type:'dsp-preset',name:'温暖'});await wait(s=>s.dsp.enabled&&s.dsp.eqDb[0]===3&&s.dsp.preampDb===-5)
 report.checks.dspPreset=true
 await send({type:'command',command:'pause'});await wait(s=>s.state==='paused'&&s.external.sourceState==='paused')
 await new Promise(r=>setTimeout(r,1500));await send({type:'command',command:'play'});await wait(s=>s.state==='playing'&&s.external.sourceState==='playing')
 report.checks.pauseResume=true
 await send({type:'seek',positionMs:15000});await wait(s=>Math.abs(s.position-15000)<3000&&Math.abs(s.external.sourcePosition-15000)<3000)
 report.checks.seek=true
 const before=read().external.audioPackets;await send({type:'command',command:'reset'});await wait(s=>s.state==='playing'&&s.external.audioPackets>before)
 report.checks.reset=true
 await send({type:'command',command:'pause'});await wait(s=>s.state==='paused')
 await send({type:'external-action',action:'disconnect'});const end=await wait(s=>s.external.phase==='disconnected')
 assert.match(end.external.message,/已恢复/);report.checks.restoreOutput=true
}catch(error){failed=true;report.error=String(error);report.state=read();console.error(error)}
finally{try{await send({type:'close'});const until=Date.now()+15000;while(child.exitCode===null&&Date.now()<until)await new Promise(r=>setTimeout(r,100));if(child.exitCode===null)child.kill()}catch{child.kill()}writeFileSync(join(folder,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));console.log('Report: '+join(folder,'result.json'));process.exitCode=failed?1:0
