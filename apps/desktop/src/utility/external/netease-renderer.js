'use strict';
const cef = Process.getModuleByName('libcef.dll');
const force = __FORCE__;
if (Process.pointerSize !== 8) throw new Error('当前原生适配器需要 64 位客户端');
if (!force && new NativeFunction(cef.getExportByName('cef_version_info'), 'int', ['int'])(0) !== 91)
    throw new Error('这版客户端的 CEF ABI 尚未验证；可以开启“强制接管”继续尝试');
const getContext = new NativeFunction(cef.getExportByName('cef_v8context_get_current_context'), 'pointer', []);
const inContext = new NativeFunction(cef.getExportByName('cef_v8context_in_context'), 'int', []);
const freeString = new NativeFunction(cef.getExportByName('cef_string_userfree_utf16_free'), 'void', ['pointer']);
const pending = [], errors = [];
let busy = false, last = 0, stopped = false, stopRequested = false, sequence = 0, previous = '';
function release(p) { if (!p.isNull()) new NativeFunction(p.add(16).readPointer(), 'int', ['pointer'])(p); }
function string(s) { const data = Memory.allocUtf16String(s), p = Memory.alloc(24); p.writePointer(data); p.add(8).writeU64(s.length); p.add(16).writePointer(ptr(0)); return { p, data }; }

// Runs only on CEF's renderer thread, inside its current V8 context. Only the
// known player, progress, lyrics and device fields are copied out of the client.
function collect(commands, finish, forceMode) {
    if (location.pathname !== '/pub/app.html') return { found: false };
    const key = '__JAP_EXTERNAL_PLAYER_BRIDGE__';
    if (!window[key]) {
        let require = null;
        const chunks = window.webpackJsonp, id = 'jap_bridge_' + Date.now();
        chunks.push([[id], { [id]: (m, e, r) => { require = r; } }, [[id]]]);
        if (!require) throw new Error('客户端模块运行时不可用');
        delete require.m[id]; delete require.c[id];
        const at = chunks.findIndex(c => c && c[0] && c[0].includes(id)); if (at >= 0) chunks.splice(at, 1);
        let tool = require.c['8']?.exports?.a, progress = require.c['109']?.exports?.b, audio = require.c['4']?.exports?.AudioPlayer;
        if(forceMode) {
            // Cached exports only: never execute arbitrary modules to find an
            // adapter. Module numbering may change without changing its API.
            const exports=Object.values(require.c).flatMap(m=>Object.values(m?.exports||{}));
            tool=typeof tool?.getStore==='function'&&typeof tool?.getDispatch==='function'?tool:exports.find(e=>typeof e?.getStore==='function'&&typeof e?.getDispatch==='function');
            audio=typeof audio?.getOutputDevices==='function'?audio:exports.find(e=>typeof e?.getOutputDevices==='function'&&typeof e?.setOutputDevice==='function');
        }
        if (!tool || typeof tool.getStore !== 'function' || typeof progress?.getValue !== 'function' || !audio) throw new Error('客户端播放器接口不匹配');
        Object.defineProperty(window, key, { configurable: true, value: { tool, progress, audio, lyricId: '', devices: null, deviceError: null } });
    }
    const bridge = window[key], acks = [], dispatch = bridge.tool.getDispatch();
    let state = bridge.tool.getStore();
    for (const c of commands) {
        const p = state.playing;
        const action = c.action;
        if (action === 'pause') dispatch({ type: 'playing/pause', payload: {} });
        else if (action === 'resume') dispatch({ type: 'playing/resume', payload: { triggerScene: 'miniBar' } });
        else if (action === 'next' || action === 'previous') dispatch({ type: p.playingMode === 'playFm' ? (action === 'next' ? 'fmPlaying/playNext' : 'fmPlaying/playPre') : 'playingList/jump2Track', payload: { flag: action === 'next' ? 1 : -1, type: 'call', triggerScene: 'miniBar' } });
        else if (action === 'seek') dispatch({ type: 'playing/setPlayingPosition', payload: { duration: Math.max(0, Math.min(Number(p.resourceDuration) || 0, c.positionMs / 1000)) } });
        else if (action === 'devices') bridge.audio.getOutputDevices().then(v => { bridge.devices = v; }, e => { bridge.deviceError = String(e); });
        else if (action === 'device') bridge.audio.setOutputDevice({ type: c.device.type, device: { id: c.device.id, name: c.device.name, deviceId: c.device.deviceId } }).catch(e => { bridge.deviceError = String(e); });
        else throw new Error('未知播放器控制指令');
        acks.push(c.id);
    }
    state = bridge.tool.getStore();
    const p = state.playing || {}, l = state['async:lyric'] || {}, track = p.curPlaying?.track || {};
    const localPath = String(p.curPlaying?.localTrack?.filename || '');
    const onlineId = p.onlineResourceId && p.onlineResourceId !== '0' ? p.onlineResourceId : '';
    const id = String(onlineId || p.resourceTrackId || localPath || p.playId || '');
    const coverUrl = [p.resourceCoverUrl, track.album?.cover, track.album?.picUrl, track.al?.picUrl]
        .find(value => typeof value === 'string' && /^(?:https?:|data:image\/)/i.test(value)) || '';
    if (id && bridge.lyricId !== id && !finish) {
        bridge.lyricId = id;
        dispatch({ type: 'async:lyric/fetchLyric', payload: { force: true } });
    }
    const snapshot = {
        found: true, acks, track: { id, title: String(p.resourceName || ''), artist: (p.resourceArtists || []).map(x => x.name).join(' / '), album: String(track.album?.name || track.al?.name || ''), durationMs: Math.round((Number(p.resourceDuration) || 0) * 1000), coverUrl, localPath },
        state: p.playingState === 2 ? 'playing' : p.playingState === 1 ? 'paused' : 'stopped', positionMs: Math.round((Number(bridge.progress.getValue()) || 0) * 1000), speed: Number(p.playingSpeed) || 1,
        lyrics: { trackId: String(l.resourceTrackId || ''), type: l.currentUsedLyric, offset: l.offset || 0, lines: l.lyricLines || [], translation: l.tlyricLines || [], romanization: l.romaLyricLines || [], yrc: l.yrcInfo?.yrc || '' },
        devices: bridge.devices, deviceError: bridge.deviceError
    };
    if (finish) { delete window[key]; snapshot.cleaned = true; }
    return snapshot;
}

let cachedContext = ptr(0), runner = ptr(0), posted = false, refs = 1;
const hooks = [], task = Memory.alloc(48), callbacks = [];
let candidates = [], scannedBytes = 0, discovery = 'waiting';
// One native CEF reference is cached for this renderer process. It has no JS
// callbacks and survives detaching the agent, so reconnecting while paused does
// not require waiting for an unrelated page event. Replaced contexts are freed
// on the owning renderer thread; the final reference ends with the process.
const kernel = Process.getModuleByName('kernel32.dll');
const getEnvironment = new NativeFunction(kernel.getExportByName('GetEnvironmentVariableW'), 'uint', ['pointer','pointer','uint']);
const setEnvironment = new NativeFunction(kernel.getExportByName('SetEnvironmentVariableW'), 'int', ['pointer','pointer']);
const cacheName = Memory.allocUtf16String('JAP_CEF_PLAYER_CONTEXT');
function rememberedContext() {
    const text=Memory.alloc(128), length=getEnvironment(cacheName,text,64);
    if(!length||length>=64)return ptr(0);
    const raw=text.readUtf16String(length);
    if(!/^0x[0-9a-f]+$/i.test(raw))return ptr(0);
    const p=ptr(raw);
    try {
        if(p.readU64().toNumber()!==112||p.add(112).readS32()<1||!p.sub(8).readPointer().equals(p.sub(32)))return ptr(0);
        for(let offset=8;offset<112;offset+=8)if(!insideCef(p.add(offset).readPointer()))return ptr(0);
        return p;
    }catch{return ptr(0);}
}
function instructions(address, limit) {
    const out = []; let p = address;
    for (let i=0;i<limit;i++) { const item=Instruction.parse(p); out.push(item); p=item.next; if(item.mnemonic==='ret')break; }
    return out;
}
function directCall(i) { return i.mnemonic==='call' && /^0x[0-9a-f]+$/i.test(i.opStr) ? ptr(i.opStr) : null; }
function insideCef(p) { return p.compare(cef.base)>=0 && p.compare(cef.base.add(cef.size))<0; }
function discoverContexts() {
    if (!cachedContext.isNull() || stopped) return;
    try {
        // Recover the exact C API callback table from this loaded CEF build.
        // The V8-context wrapper has a public 112-byte API, a 32-byte owner
        // header and its native reference counter immediately after the API.
        let descriptor=null;
        for(const call of instructions(cef.getExportByName('cef_v8context_get_current_context'),64).map(directCall).filter(Boolean)) {
            if(!insideCef(call))continue;
            const wrap=instructions(call,64), allocation=wrap.findIndex(i=>i.mnemonic==='mov' && /^ecx, 0x98$/i.test(i.opStr));
            if(allocation<0)continue;
            const calls=wrap.slice(allocation+1).map(directCall).filter(Boolean);
            if(calls.length<2)continue;
            const table=new Map();let loaded=null,vtable=null,validSize=false;
            for(const i of instructions(calls[1],96)) {
                if(i.mnemonic==='lea') {
                    const m=/^rcx, \[rip ([+-]) 0x([0-9a-f]+)\]$/i.exec(i.opStr);
                    loaded=m?i.next.add((m[1]==='-'?-1:1)*parseInt(m[2],16)):null;
                } else if(i.mnemonic==='mov') {
                    if(/^qword ptr \[rax \+ 0x20\], 0x70$/i.test(i.opStr))validSize=true;
                    const m=/^qword ptr \[rax \+ 0x([0-9a-f]+)\], rcx$/i.exec(i.opStr);
                    if(m&&loaded)table.set(parseInt(m[1],16)-32,loaded);
                    if(/^qword ptr \[rax\], rcx$/i.test(i.opStr)&&loaded)vtable=loaded;
                }
            }
            if(validSize&&vtable&&Array.from({length:13},(_,i)=>8+i*8).every(n=>table.has(n)&&insideCef(table.get(n)))) { descriptor={table,vtable};break; }
        }
        if(!descriptor){discovery='callbackTableUnavailable';return;}
        const patternMemory=Memory.alloc(112);patternMemory.writeU64(112);
        for(const [offset,address] of descriptor.table)if(offset>=8&&offset<112)patternMemory.add(offset).writePointer(address);
        const pattern=Array.from(new Uint8Array(patternMemory.readByteArray(112)),x=>x.toString(16).padStart(2,'0')).join(' ');
        const budget=192*1024*1024;
        for(const range of Process.enumerateRanges({protection:'rw-',coalesce:true})) {
            if(scannedBytes>=budget||candidates.length>=64)break;
            if(range.file||range.size<112)continue;
            const size=Math.min(range.size,16*1024*1024,budget-scannedBytes);scannedBytes+=size;
            try { for(const match of Memory.scanSync(range.base,size,pattern)) {
                const p=match.address;
                if(p.sub(8).readPointer().equals(p.sub(32)) && p.sub(32).readPointer().equals(descriptor.vtable) && p.add(112).readS32()>0 && p.add(112).readS32()<1000000)candidates.push(p);
            } } catch {}
        }
        discovery='typedCandidates:'+candidates.length;
        schedule();
    } catch(e) { discovery='unavailable:'+String(e); }
}
function evaluate(context) {
    let value = ptr(0), exception = ptr(0), text = ptr(0);
    try {
        const contextSize = context.readU64().toNumber();
        if (contextSize !== 112 && (!force || contextSize < 112 || contextSize > 512)) throw new Error('CEF context ABI mismatch');
        if (!new NativeFunction(context.add(48).readPointer(), 'int', ['pointer'])(context)) return false;
        last = Date.now();
        const commands = pending.splice(0), code = string('JSON.stringify((' + collect.toString() + ')(' + JSON.stringify(commands) + ',' + stopRequested + ',' + force + '))'), url = string('jap-external-player');
        const output = Memory.alloc(8), error = Memory.alloc(8); output.writePointer(ptr(0)); error.writePointer(ptr(0));
        const ok = new NativeFunction(context.add(104).readPointer(), 'int', ['pointer', 'pointer', 'pointer', 'int', 'pointer', 'pointer'])(context, code.p, url.p, 1, output, error);
        value = output.readPointer(); exception = error.readPointer();
        if (!ok || value.isNull()) throw new Error('读取播放器状态失败');
        text = new NativeFunction(value.add(192).readPointer(), 'pointer', ['pointer'])(value);
        if (text.isNull()) throw new Error('播放器状态不是字符串');
        const size = text.add(8).readU64().toNumber(); if (size > 1024 * 1024) throw new Error('播放器状态超出预算');
        const json = text.readPointer().readUtf16String(size), parsed = JSON.parse(json);
        if (!parsed.found) pending.unshift(...commands);
        if (json !== previous) { previous = json; send({ event: 'snapshot', value: parsed }); }
        if (stopRequested && parsed.found) stopped = true;
        return !!parsed.found;
    } catch (e) { if (errors.length < 10) { errors.push(String(e)); send({ event: 'error', message: String(e) }); } }
    finally { if (!text.isNull()) freeString(text); release(value); release(exception); }
    return false;
}
function keepContext(context) {
    if (!cachedContext.isNull()) return;
    const target = new NativeFunction(context.add(40).readPointer(), 'pointer', ['pointer'])(context);
    if (target.isNull() || target.readU64().toNumber() !== 80) { release(target); throw new Error('CEF task runner ABI mismatch'); }
    new NativeFunction(context.add(8).readPointer(), 'void', ['pointer'])(context);
    const remembered=rememberedContext();
    if(!remembered.equals(context)) {
        new NativeFunction(context.add(8).readPointer(), 'void', ['pointer'])(context);
        if(setEnvironment(cacheName,Memory.allocUtf16String(context.toString())))release(remembered);
        else release(context);
    }
    release(runner); cachedContext = context; runner = target;
}
function releaseContext() {
    // Called by the task on its owning renderer thread, after leaving V8.
    release(cachedContext); release(runner); cachedContext = runner = ptr(0);
}
function callback(type, args, fn) { const c = new NativeCallback(fn, type, args); callbacks.push(c); return c; }
function retainTask() { refs++; if (refs === 2) Script.pin(); }
task.writeU64(48);
task.add(8).writePointer(callback('void', ['pointer'], retainTask));
task.add(16).writePointer(callback('int', ['pointer'], () => { refs--; if (refs === 1) Script.unpin(); return refs === 0 ? 1 : 0; }));
task.add(24).writePointer(callback('int', ['pointer'], () => refs === 1 ? 1 : 0));
task.add(32).writePointer(callback('int', ['pointer'], () => refs > 0 ? 1 : 0));
task.add(40).writePointer(callback('void', ['pointer'], () => {
    busy = true;
    let entered = false;
    try {
        if (cachedContext.isNull()) {
            // Acquire and inspect typed live objects only on the owning CEF
            // render thread. No page content or unrelated memory is exported.
            for(const context of candidates.splice(0)) {
                let held=false, target=ptr(0), scope=false;
                try {
                    if(context.add(112).readS32()<1)continue;
                    new NativeFunction(context.add(8).readPointer(),'void',['pointer'])(context);held=true;
                    target=new NativeFunction(context.add(40).readPointer(),'pointer',['pointer'])(context);
                    if(target.isNull()||target.readU64().toNumber()!==80||!new NativeFunction(target.add(48).readPointer(),'int',['pointer'])(target))continue;
                    scope=!!new NativeFunction(context.add(80).readPointer(),'int',['pointer'])(context);
                    if(scope&&evaluate(context)){keepContext(context);discovery='typedContext';break;}
                } catch(e) { discovery='candidateUnavailable:'+String(e); }
                finally { if(scope)new NativeFunction(context.add(88).readPointer(),'int',['pointer'])(context);release(target);if(held)release(context); }
            }
            return;
        }
        entered = !!new NativeFunction(cachedContext.add(80).readPointer(), 'int', ['pointer'])(cachedContext);
        if (entered) evaluate(cachedContext);
        else if (stopRequested) stopped = true;
    } finally {
        if (entered) new NativeFunction(cachedContext.add(88).readPointer(), 'int', ['pointer'])(cachedContext);
        if (stopped) releaseContext();
        busy = false; posted = false;
    }
}));
function schedule() {
    // GetTaskRunner is callable from any renderer-process thread. Use the
    // context's runner instead of an integer CefThreadId, whose enum changes
    // between builds and can silently return null on an idle renderer.
    if(runner.isNull()&&candidates.length&&!stopped) {
        for(const context of candidates) {
            try {
                const target=new NativeFunction(context.add(40).readPointer(),'pointer',['pointer'])(context);
                if(!target.isNull()&&target.readU64().toNumber()===80){runner=target;break;}
                release(target);
            }catch{}
        }
    }
    if (runner.isNull() || (cachedContext.isNull()&&!candidates.length) || posted || stopped || busy) return;
    posted = true;
    // The C API consumes one task reference per PostTask invocation. Keep our
    // reusable baseline reference separate from the reference being passed in.
    retainTask();
    const ok = new NativeFunction(runner.add(64).readPointer(), 'int', ['pointer', 'pointer'])(runner, task);
    if (!ok) { posted = false; send({ event: 'error', message: 'CEF 控制任务投递失败' }); }
}
// Bootstrap from any native V8 value, then retain the verified main context and
// actively post tasks. An idle/paused/minimized page needs no mouse event.
for (const name of ['string','int','uint','double','bool','object','array','function']) {
    const address = cef.findExportByName('cef_v8value_create_' + name);
    if (!address) continue;
    hooks.push(Interceptor.attach(address, { onEnter() {
        if (!cachedContext.isNull() || busy || stopped) return;
        busy = true; let context = ptr(0);
        try { if (!inContext()) return; context = getContext(); if (!context.isNull() && evaluate(context)) keepContext(context); }
        finally { release(context); busy = false; }
    } }));
}
const timer = setInterval(schedule, 200);
const remembered=rememberedContext();
if(!remembered.isNull()){candidates.push(remembered);discovery='rememberedContext';schedule();}
setTimeout(discoverContexts,500);
rpc.exports = {
    command(value) {
        if (stopped || pending.length >= 16 || !['pause','resume','next','previous','seek','devices','device'].includes(value.action)) throw new Error('控制指令无效或队列已满');
        if (value.action === 'seek' && (!Number.isFinite(value.positionMs) || value.positionMs < 0)) throw new Error('无效跳转位置');
        const id = ++sequence; pending.push({ ...value, id }); schedule(); return id;
    },
    snapshot() { return { stopped, errors, initialized: !cachedContext.isNull(), posted, taskReferences: refs, discovery, scannedBytes }; },
    async stop() {
        stopRequested = true; schedule(); const end = Date.now() + 4000;
        while ((!stopped || refs > 1) && Date.now() < end) await new Promise(r => setTimeout(r, 25));
        clearInterval(timer);
        if (refs > 1) throw new Error('CEF 控制任务仍在执行，暂未卸下 Hook');
        if(cachedContext.isNull()){release(runner);runner=ptr(0);}
        for (const h of hooks) h.detach(); stopped = true;
    }
};
