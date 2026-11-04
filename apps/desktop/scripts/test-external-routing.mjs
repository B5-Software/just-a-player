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
const nextOpened=[],commands=[]
const next=new ExternalPlayer({send:json=>commands.push(JSON.parse(json)),closeLive(){},openLive:json=>nextOpened.push(JSON.parse(json)),pushLive(){}},'unused',()=>{})
next.state={phase:'routing',snapshot:{...snapshot,positionMs:59000},audioPackets:0,nullBytes:'0',cover:null}
next.lastNativeState='playing';next.stream='test:3:flac:';next.nextFrame=12000000
next.onAudio({...packet,stream:4,pts:'0'},Buffer.from([8]))
assert.equal(nextOpened.length,0,'next decoder read-ahead must wait for matching metadata')
assert.equal(next.pendingAudio.length,1)
next.onSnapshot({...snapshot,track:{...snapshot.track,id:'next',title:'Next'},positionMs:200})
assert.equal(nextOpened.length,1)
assert.equal(nextOpened[0].track.title,'Next')
assert.equal(nextOpened[0].startFrame,0,'natural advancement keeps the first packet')
assert.equal(commands.filter(c=>c.type==='seek'||c.type==='play').length,0,'no competing local seek/play during natural next')
next.engineEvent({type:'error',message:'An unrelated library probe failed'})
assert.equal(next.snapshot().phase,'routing')
next.onSnapshot({...snapshot,track:{...snapshot.track,id:'next',title:'Next'},state:'stopped',positionMs:60000})
assert.equal(next.capturePaused,false,'between-track stopped state must keep capture armed')
const transient=new ExternalPlayer(engine,'unused',()=>{})
transient.state={phase:'ready',snapshot,audioPackets:0,nullBytes:'0',cover:null};transient.virtual={}
let attempts=0;transient.rpc=async()=>{if(++attempts<=2)throw Error('Temporary timeout');return{buffers:0,discardedBytes:'0'}};transient.command=async()=>{}
await transient.poll();await transient.poll();assert.equal(transient.snapshot().phase,'ready');await transient.poll();assert.equal(transient.pollFailures,0)
console.log('Live routing passed: exact seek, stale generations, natural next/read-ahead, transient retry, unrelated probe errors, JPEG and cover retry.')
