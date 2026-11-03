import assert from 'node:assert/strict'
import { build } from 'vite'
import { resolve } from 'node:path'
const cwd=resolve(import.meta.dirname,'..'), out=resolve(cwd,'test-results/external-routing')
await build({configFile:false,build:{lib:{entry:resolve(cwd,'src/utility/external-player.ts'),formats:['es'],fileName:()=>'adapter.mjs'},outDir:out,emptyOutDir:false,rollupOptions:{external:id=>id==='frida'||id.startsWith('node:')}}})
const {ExternalPlayer}=await import(new URL('../test-results/external-routing/adapter.mjs',import.meta.url))
const opened=[],pushed=[]
const engine={send(){},closeLive(){},openLive:json=>opened.push(JSON.parse(json)),pushLive:(pts,frames,data)=>pushed.push([pts,frames,data])}
const adapter=new ExternalPlayer(engine,'unused',()=>{})
const snapshot={found:true,acks:[],track:{id:'test',title:'Test',artist:'B5-Software',album:'CI',durationMs:60000,coverUrl:''},state:'playing',positionMs:40000,speed:1,lyrics:{trackId:'test',lines:[],translation:[],romanization:[],yrc:'',offset:0},devices:null}
adapter.state={phase:'routing',snapshot,audioPackets:0,nullBytes:'0',cover:null};adapter.seekTargetMs=15000;adapter.seekStreamFloor=1
const packet={event:'audio',stream:2,pts:'2867200',frames:32768,codec:'flac',encoding:'flac',float:false,sampleRate:192000,channels:2,bits:24,streaminfo:new Array(34).fill(0)}
adapter.onAudio(packet,Buffer.from([1]))
assert.equal(opened.length,0);assert.equal(adapter.seekTargetMs,15000,'a stale UI clock must not consume the seek trim')
adapter.onAudio({...packet,pts:'4816896'},Buffer.from([2]));assert.equal(opened.length,0,'old read-ahead must not establish the new clock')
adapter.state.snapshot={...snapshot,positionMs:15000}
adapter.onAudio(packet,Buffer.from([3]));assert.equal(opened.length,1);assert.equal(opened[0].startFrame+opened[0].trimStartFrames,2880000)
adapter.onAudio({...packet,stream:1,pts:'4816896'},Buffer.from([4]));assert.equal(opened.length,1);assert.equal(pushed.length,1)
adapter.onAudio({...packet,pts:String(2867200+32768)},Buffer.from([5]));assert.equal(pushed.length,2)
const jpeg=new Uint8Array([255,216,255,224]), fetch=globalThis.fetch,now=Date.now
let calls=0,clock=now();Date.now=()=>clock
globalThis.fetch=async()=>++calls===1?new Response('',{status:503}):new Response(jpeg,{headers:{'content-type':'image/jpg'}})
const covers=new ExternalPlayer(engine,'unused',()=>{}), source={...snapshot,track:{...snapshot.track,coverUrl:'https://p1.music.126.net/test.jpg'}}
try{
 covers.onSnapshot(source);await new Promise(r=>setTimeout(r,0));assert.equal(calls,1);assert.equal(covers.snapshot().cover,null)
 clock+=2000;covers.onSnapshot(source);await new Promise(r=>setTimeout(r,0));assert.equal(calls,2);assert.equal(covers.snapshot().cover.mime,'image/jpeg')
}finally{globalThis.fetch=fetch;Date.now=now;await covers.disconnect()}
console.log('Live routing: exact seek trim, stale generations, continuity, CDN JPEG and retry passed.')
