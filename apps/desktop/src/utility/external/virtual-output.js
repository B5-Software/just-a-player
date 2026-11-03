'use strict';
// The native DLL owns its COM vtables and clocks. No JS callbacks are left in
// audio buffers, so objects remain valid if the instrumentation disconnects.
const kernel = Process.getModuleByName('kernel32.dll');
const loadLibrary = new NativeFunction(kernel.getExportByName('LoadLibraryW'), 'pointer', ['pointer']);
const dllPath = __DLL_PATH__;
const handle = loadLibrary(Memory.allocUtf16String(dllPath));
if (handle.isNull()) throw new Error('无法载入 Just A Player 虚拟输出模块');
const moduleHolder = Memory.alloc(Process.pointerSize);
const pinModule = new NativeFunction(kernel.getExportByName('GetModuleHandleExW'), 'int', ['uint', 'pointer', 'pointer']);
if (!pinModule(1, Memory.allocUtf16String(dllPath), moduleHolder)) throw new Error('无法固定原生空输出模块的进程生命周期');
const dll = Process.enumerateModules().find(m => m.base.equals(handle));
if (!dll) throw new Error('无法定位原生空输出模块');
const createNull = new NativeFunction(dll.getExportByName('jap_null_create'), 'int', ['pointer', 'pointer', 'pointer']);
const guid = new NativeFunction(dll.getExportByName('jap_null_guid'), 'pointer', [])();
const buffers = new NativeFunction(dll.getExportByName('jap_null_buffer_count'), 'uint', []);
const discarded = new NativeFunction(dll.getExportByName('jap_null_discarded_bytes'), 'uint64', []);
const name = Memory.allocUtf16String('Just A Player HiFi Bridge (Black Hole)');
const description = Memory.allocUtf16String('Just A Player native null output');
const expected = new Uint8Array(guid.readByteArray(16));
const hooks = [], replaced = [], callbacks = [];
let enumerations = 0, creations = 0, inFlight = 0;
function isVirtual(p) {
    if (p.isNull()) return false;
    const bytes = new Uint8Array(p.readByteArray(16));
    return bytes.every((v, i) => v === expected[i]);
}
const ds = Process.getModuleByName('dsound.dll');
const enumerate = ds.findExportByName('DirectSoundEnumerateW');
if (!enumerate) throw new Error('客户端未提供可验证的 DirectSound 设备枚举');
hooks.push(Interceptor.attach(enumerate, {
    onEnter(args) { this.enumCallback = args[0]; this.enumUserContext = args[1]; },
    onLeave(result) {
        if (result.toInt32() < 0 || this.enumCallback.isNull()) return;
        new NativeFunction(this.enumCallback, 'int', ['pointer', 'pointer', 'pointer', 'pointer'])(guid, name, description, this.enumUserContext);
        enumerations++;
    }
}));
for (const factoryName of ['DirectSoundCreate', 'DirectSoundCreate8']) {
    const address = ds.findExportByName(factoryName);
    if (!address) continue;
    const original = new NativeFunction(address, 'int', ['pointer', 'pointer', 'pointer']);
    const replacement = new NativeCallback((device, output, outer) => {
        inFlight++;
        try {
            if (!isVirtual(device)) return original(device, output, outer);
            const result = createNull(device, output, outer);
            if (result === 0) creations++;
            return result;
        } finally { inFlight--; }
    }, 'int', ['pointer', 'pointer', 'pointer']);
    callbacks.push(replacement);
    Interceptor.replace(address, replacement);
    replaced.push(address);
}
rpc.exports = {
    snapshot() { return { enumerations, creations, inFlight, buffers: buffers(), discardedBytes: discarded().toString(), name: 'Just A Player HiFi Bridge (Black Hole)', scope: 'clientProcess', physicalEndpointsOpened: 0 }; },
    async stop() {
        const end = Date.now() + 4000;
        while (inFlight && Date.now() < end) await new Promise(r => setTimeout(r, 20));
        if (inFlight) throw new Error('客户端仍在创建设备，尚不能卸下输出 Hook');
        for (const h of hooks) h.detach(); for (const p of replaced) Interceptor.revert(p); Interceptor.flush();
    }
};
send({ event: 'virtualReady', scope: 'clientProcess', name: 'Just A Player HiFi Bridge (Black Hole)' });
