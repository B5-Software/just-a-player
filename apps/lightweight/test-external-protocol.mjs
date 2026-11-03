// CI: exercise the real native pipe, live Rust decoder and transport without
// installing or instrumenting a third-party client.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
if(process.platform!=='win32'){console.log('Native Windows adapter transport test skipped on this platform.');process.exit(0)}
const root=resolve(import.meta.dirname,'../..'),desktop=join(root,'apps/desktop'),require=createRequire(join(desktop,'package.json'))
const folder=join(desktop,'test-results/native-pipe-'+Date.now());mkdirSync(folder,{recursive:true})
const packed=process.argv.includes('--packaged'),resources=join(desktop,packed?'release/win-unpacked/resources':'build'),binary=packed?join(resources,'lightweight/jap-lightweight.exe'):join(root,'target/debug/jap-lightweight.exe')
const cover=readFileSync(join(desktop,'build/icon.png')).toString('base64')
writeFileSync(join(folder,'external-service.js'),`
const fs=require('node:fs'),readline=require('node:readline');let frame=0,playing=false,timer=null,closing=false,phase='ready';const actions=[];
function out(v,b=Buffer.alloc(0)){const j=Buffer.from(JSON.stringify(v)),h=Buffer.alloc(8);h.writeUInt32LE(j.length);h.writeUInt32LE(b.length,4);process.stdout.write(Buffer.concat([h,j,b]));}
function state(image=false){out({kind:'externalState',state:{phase,message:phase==='disconnected'?'已恢复测试设备':'Native pipe test',audioPackets:frame,nullBytes:String(frame*4),snapshot:{track:{id:'native-test'},state:playing?'playing':'paused',positionMs:Math.round(frame/48),devices:{currentDevice:{name:phase==='routing'?'Just A Player HiFi Bridge (Black Hole)':'Test output'}}},lyricsText:'[00:00.000]Native wire\\n[00:01.000]Sample clock',...(image?{cover:{mime:'image/png'}}:{})}},image?Buffer.from('${cover}','base64'):undefined);}
function open(at=0){frame=Math.round(at*48);out({kind:'openLive',config:{track:{path:'external://netease/native-test',codec:'Test PCM',format:{sampleRate:48000,channels:2,bits:16,float:false},durationMs:60000,lossless:true,bitrateKbps:null,title:'Native wire',artist:'B5-Software',album:'CI'},encoding:{type:'pcm',format:'i16',planar:false},startFrame:frame,trimStartFrames:0}});}
timer=setInterval(()=>{if(playing&&phase==='routing'){out({kind:'audio',pts:frame,frames:960},Buffer.alloc(3840));frame+=960;if(frame%4800===0)state();}},20);
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.kind==='shutdown'){closing=true;playing=false;out({kind:'closeLive'});out({kind:'command',command:{type:'stop'}});return;}if(m.kind==='event'&&m.event.type==='state'&&m.event.state==='stopped'&&closing){clearInterval(timer);phase='disconnected';state();out({kind:'shutdownDone'});fs.writeFileSync(${JSON.stringify(join(folder,'requests.json'))},JSON.stringify(actions));setTimeout(()=>process.exit(0),50);return;}if(m.kind!=='action')return;actions.push(m.action);switch(m.action){case'connect':state();break;case'route':phase='routing';open();state(true);playing=true;break;case'pause':playing=false;out({kind:'command',command:{type:'pause'}});state();break;case'resume':playing=true;out({kind:'command',command:{type:'resume'}});state();break;case'seek':open(m.positionMs||0);state();break;}});
`)
const start=join(folder,'start.json');writeFileSync(start,JSON.stringify({volume:0.2,state:'stopped',output:{api:'null',deviceId:null,bufferMs:40,dsdMode:'pcm'}}))
const child=spawn(binary,['--qa','--qa-hidden','--data-dir',folder,'--resources',resources,'--return-app',require('electron'),'--return-entry',join(folder,'index.js'),'--handoff',start],{windowsHide:true,stdio:'pipe'})
let logs='';child.stderr.on('data',b=>logs+=b);child.stdout.on('data',b=>logs+=b)
function read(){try{return JSON.parse(readFileSync(join(folder,'native-report.json'),'utf8'))}catch{return null}}
async function wait(test){const end=Date.now()+20000;while(Date.now()<end){const s=read();if(s&&test(s))return s;if(s?.error)throw Error(s.error);if(child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,50))}throw Error('Native pipe timeout: '+JSON.stringify(read())+' '+logs)}
async function send(v){const p=join(folder,'native-input.json');while(existsSync(p))await new Promise(r=>setTimeout(r,20));writeFileSync(p+'.pending',JSON.stringify(v));renameSync(p+'.pending',p)}
try{
 await wait(s=>s.external.available);await send({type:'external-connect',force:true});await wait(s=>s.external.phase==='ready');await send({type:'external-action',action:'route'});
 const state=await wait(s=>s.state==='playing'&&s.hasDecodedCover&&s.lyricLines>0&&s.position>100);assert.equal(state.webview,false);assert.equal(state.renderResourcesResident,false)
 await send({type:'command',command:'pause'});await wait(s=>s.state==='paused');await send({type:'command',command:'play'});await wait(s=>s.state==='playing');
 await send({type:'seek',positionMs:15000});await wait(s=>Math.abs(s.position-15000)<1000);await send({type:'command',command:'next'});await send({type:'command',command:'previous'});
 await send({type:'external-action',action:'disconnect'});await wait(s=>s.external.phase==='disconnected');const actions=JSON.parse(readFileSync(join(folder,'requests.json'),'utf8'));assert(actions.includes('next')&&actions.includes('previous')&&actions.includes('seek'));console.log('Native pipe: binary PCM, cover/lyrics, pause/resume, seek, next/previous and stopped acknowledgement passed.');
}finally{try{await send({type:'close'})}catch{}const end=Date.now()+15000;while(child.exitCode===null&&Date.now()<end)await new Promise(r=>setTimeout(r,50));if(child.exitCode===null)child.kill();}
