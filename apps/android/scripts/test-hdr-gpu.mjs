import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { adb, connect, delay } from './emulator-cdp.mjs'

const app = 'org.b5_software.justaplayer.debug'
adb(
  'shell',
  'am',
  'start',
  '-W',
  '-n',
  app + '/org.b5_software.justaplayer.MainActivity',
  '--ez',
  'e2e',
  'true'
)
const c = await connect(),
  results = []
try {
  for (let n = 0; n < 200; n++) {
    if (await c.evaluate('!!window.__jap?.usePlayer.getState().connected&&!!window.__japViz')) break
    await delay(150)
  }
  assert.ok(
    await c.evaluate('!!window.__jap&&!!window.__japViz'),
    'Player initialized before GPU comparison'
  )
  for (const id of [
    'silk-studio',
    'tidal-studio',
    'dune-studio',
    'glass-studio',
    'orb',
    'galaxy',
    'tunnel',
    'city',
    'ribbon',
    'plasma',
    'terrain',
    'scope',
    'spectrum',
    'spectrogram',
    'vectorscope',
    'vu',
    'antialias-test',
  ].filter((id) => process.argv.length < 3 || process.argv.slice(2).includes(id))) {
    console.log(`Comparing shader: ${id}`)
    if (id !== 'antialias-test')
      await c.evaluate(
        `(async()=>{__jap.useUi.getState().setOnboardingOpen(false);__jap.useSettings.getState().update({renderScale:.25,renderFps:15,enabledLegacyVisuals:${JSON.stringify(id.endsWith('-studio') ? [] : [id])},disabledVisuals:[],autoBackdrop:false});await __jap.prepareScenes();__jap.useViz.getState().setScene(${JSON.stringify(id)})})()`
      )
    for (let n = 0; n < 100 && id !== 'antialias-test'; n++) {
      if (await c.evaluate(`window.__japViz?.currentId===${JSON.stringify(id)}`)) break
      await delay(100)
    }
    if (id !== 'antialias-test') assert.equal(await c.evaluate('__japViz.currentId'), id)
    const frameExpression =
      id === 'antialias-test'
        ? `await (async()=>{const aa=await (await fetch('shaders/antialias.glsl')).text();return {fragment:'uniform highp sampler2D uLabels;uniform vec2 uRes;\\n#define JA_TEXTURE texture\\n'+aa+'\\nvec3 visualize(vec2 uv){return jaAntialias(uLabels,uv,uRes)*2.;}',uniforms:{},textures:[{name:'uLabels',width:32,height:18,version:1,data:Uint8Array.from({length:32*18},(_,i)=>(i%32)>Math.floor(i/32)*1.4?255:0)}]}})()`
        : '__japViz.current.nativeShader()'
    const r = await c.evaluate(`(async()=>{
   const frame=${frameExpression};frame.uniforms=JSON.parse(JSON.stringify({...frame.uniforms,uRes:[32,18],uView:[0,0,1],uTime:3.25,uAudio:[.1,.05,.02,.08],uBackdropOn:0}));
   for(const key of ['uBands','uHold','uWave'])if(Array.isArray(frame.uniforms[key]))frame.uniforms[key]=frame.uniforms[key].map((_,i)=>key==='uWave'?Math.sin(i*.12)*.3:.15+.55*Math.exp(-Math.pow((i-48)/20,2))+(key==='uHold'?.05:0));
   if(frame.uniforms.uLevel)frame.uniforms.uLevel=[.35,.45,.2,.25];if(frame.uniforms.uVu)frame.uniforms.uVu=[.65,.5,.8,.7];
   for(const t of frame.textures??[]){if(t.name==='uStereoTrace')t.data=Uint8Array.from({length:256},(_,i)=>Math.round(128+Math.sin((i%128)*.12+(i>127?.7:0))*60));if(t.name==='uHistory')t.data=Uint8Array.from({length:t.width*t.height},(_,i)=>Math.round(32+200*(.5+.5*Math.sin(i%t.width*.13))));}
   const canvas=document.createElement('canvas');canvas.width=32;canvas.height=18;
   const gl=canvas.getContext('webgl2');if(!gl.getExtension('EXT_color_buffer_float'))throw Error('Float reference unavailable');
   const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s};
   const p=gl.createProgram();gl.attachShader(p,compile(gl.VERTEX_SHADER,'#version 300 es\\nprecision highp float;out vec2 vUv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vUv=p;gl_Position=vec4(p*2.-1.,0.,1.);}'));
   gl.attachShader(p,compile(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float;in vec2 vUv;out vec4 color;'+frame.fragment+'\\nvoid main(){color=vec4(clamp(visualize(vUv),vec3(0.),vec3(8.)),1.);}'));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));gl.useProgram(p);
   for(const [key,value] of Object.entries(frame.uniforms)){const loc=gl.getUniformLocation(p,key);if(Array.isArray(value))gl['uniform'+(value.length>4?4:value.length)+'fv'](loc,value);else gl.uniform1f(loc,value)}
   const texture=(format,w,h,type,data)=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,format,w,h,0,gl.RGBA,type,data);return t};
   const target=texture(gl.RGBA16F,32,18,gl.HALF_FLOAT,null),fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
   texture(gl.RGBA8,1,1,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
   for(let i=0;i<(frame.textures?.length||0);i++){const t=frame.textures[i];gl.activeTexture(gl.TEXTURE2+i);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);const image=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,image);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,t.width,t.height,0,gl.RED,gl.UNSIGNED_BYTE,t.data);gl.uniform1i(gl.getUniformLocation(p,t.name),2+i)}
   gl.viewport(0,0,32,18);gl.drawArrays(gl.TRIANGLES,0,3);
   const reference=new Float32Array(32*18*4);gl.readPixels(0,0,32,18,gl.RGBA,gl.FLOAT,reference);if(gl.getError())throw Error('Reference GL read failed');
   gl.getExtension('WEBGL_lose_context')?.loseContext();
   const native=await window.jap.nativeHdr.validate({...frame,textures:__jap.serializeNativeTextures(frame.textures)});let sum=0,max=0;for(let n=0;n<reference.length;n++){const e=Math.abs(reference[n]-native.pixels[n]);sum+=e;max=Math.max(max,e)}
   return {meanAbsoluteError:sum/reference.length,maxError:max,referencePeak:Math.max(...reference),referenceMin:Math.min(...reference),referenceNonfinite:Array.from(reference).filter(v=>!Number.isFinite(v)).length,renderer:native.renderer,peak:Math.max(...native.pixels),edgePixels:native.pixels.filter((v,i)=>i%4===0&&v>.01&&v<1.99).length};
  })()`)
    if (r.meanAbsoluteError >= 0.005 || r.maxError >= 0.1) console.log(JSON.stringify({ id, ...r }))
    assert.ok(r.meanAbsoluteError < 0.005 && r.maxError < 0.1, JSON.stringify({ id, ...r }))
    if (id === 'antialias-test') {
      assert.ok(r.peak > 1.9)
      assert.ok(
        r.edgePixels > 10,
        'Antialiasing smooths diagonal edges while preserving HDR values'
      )
    }
    results.push({ id, ...r })
    fs.writeFileSync(
      fileURLToPath(new URL('../test-results/hdr-gpu-progress.json', import.meta.url)),
      JSON.stringify(results, null, 2)
    )
  }
  assert.deepEqual(c.errors, [])
  const report = {
    status: 'passed',
    complete: process.argv.length < 3,
    scope:
      'Shared shader WebGL vs native EGL float framebuffer; SDR emulator does not validate HDR display luminance',
    results,
  }
  fs.writeFileSync(
    fileURLToPath(
      new URL(
        process.argv.length < 3
          ? '../test-results/hdr-gpu.json'
          : '../test-results/hdr-gpu-subset.json',
        import.meta.url
      )
    ),
    JSON.stringify(report, null, 2)
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  c.close()
}
