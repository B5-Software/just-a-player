'use strict';
const force = __FORCE__;
const codec = Process.findModuleByName('avcodec-58.dll') || (force ? Process.enumerateModules().find(m => /^avcodec-\d+\.dll$/i.test(m.name)) : null);
if (!codec) throw new Error('未发现可连接的 FFmpeg 解码模块');
if (Process.pointerSize !== 8) throw new Error('当前原生适配器需要 64 位客户端');
if (!force && new NativeFunction(codec.getExportByName('avcodec_version'), 'uint', [])() !== 3824484)
    throw new Error('这版客户端的 FFmpeg ABI 尚未验证；可以开启“强制接管”继续尝试');
const alloc = new NativeFunction(codec.getExportByName('avcodec_parameters_alloc'), 'pointer', []);
const copy = new NativeFunction(codec.getExportByName('avcodec_parameters_from_context'), 'int', ['pointer', 'pointer']);
const free = new NativeFunction(codec.getExportByName('avcodec_parameters_free'), 'void', ['pointer']);
const codecName = new NativeFunction(codec.getExportByName('avcodec_get_name'), 'pointer', ['int']);
const util = Process.enumerateModules().find(m => /^avutil-\d+\.dll$/i.test(m.name));
const optInt = util ? new NativeFunction(util.getExportByName('av_opt_get_int'), 'int', ['pointer', 'pointer', 'int', 'pointer']) : null;
const optQ = util ? new NativeFunction(util.getExportByName('av_opt_get_q'), 'int', ['pointer', 'pointer', 'int', 'pointer']) : null;
function option(ctx, name) { if (!optInt) return 0; const p = Memory.alloc(8); return optInt(ctx, Memory.allocUtf8String(name), 0, p) >= 0 ? p.readS64().toNumber() : 0; }
const contexts = new Map(), packets = new Map(), hooks = [];
let serial = 0, count = 0, enabled = false, lastUnsupported = '';
function parameters(ctx) {
    const key = ctx.toString();
    if (contexts.has(key)) return contexts.get(key);
    const p = alloc();
    try {
        if (p.isNull() || copy(p, ctx) < 0 || p.readS32() !== 1) return null;
        const name = codecName(p.add(4).readS32()).readUtf8String();
        const rate = option(ctx, 'ar') || p.add(116).readS32(), channels = option(ctx, 'ac') || p.add(112).readS32(), rawBits = p.add(44).readS32();
        if (rate < 8000 || rate > 12288000 || channels < 1 || channels > 8) return null;
        const bits = rawBits >= 1 && rawBits <= 64 ? rawBits : null;
        const encoded = name === 'flac' && p.add(24).readS32() === 34 && bits >= 4 && bits <= 32;
        let numerator = 0, denominator = 0;
        if (optQ) { const q = Memory.alloc(8); if (optQ(ctx, Memory.allocUtf8String('pkt_timebase'), 0, q) >= 0) { numerator = q.readS32(); denominator = q.add(4).readS32(); } }
        const info = { stream: ++serial, codec: name, sampleRate: rate, channels, bits, numerator, denominator, encoded, streaminfo: encoded ? Array.from(new Uint8Array(p.add(16).readPointer().readByteArray(34))) : null };
        contexts.set(key, info); return info;
    } finally { if (!p.isNull()) { const holder = Memory.alloc(8); holder.writePointer(p); free(holder); } }
}
hooks.push(Interceptor.attach(codec.getExportByName('avcodec_send_packet'), {
    onEnter(args) {
        this.entry = null;
        if (!enabled || args[1].isNull()) return;
        const info = parameters(args[0]); if (!info || !info.encoded) return;
        const packet = args[1], n = packet.add(32).readS32(), data = packet.add(24).readPointer();
        if (n < 4 || n > 2 * 1024 * 1024 || data.isNull() || data.readU8() !== 255 || (data.add(1).readU8() & 254) !== 248) return;
        const pts = packet.add(8).readS64().toString();
        this.entry = { key: args[0].toString() + ':' + pts, info, pts, data: data.readByteArray(n) };
    },
    onLeave(result) {
        if (!this.entry || result.toInt32() < 0) return;
        // FFmpeg receives only a bounded number of in-flight FLAC packets.
        if (packets.size >= 64) { enabled = false; packets.clear(); send({ event: 'error', message: '原生解码器在途包超过预算，已停止路由' }); return; }
        packets.set(this.entry.key, this.entry);
    }
}));
hooks.push(Interceptor.attach(codec.getExportByName('avcodec_receive_frame'), {
    onEnter(args) { this.ctx = args[0].toString(); this.frame = args[1]; },
    onLeave(result) {
        if (!enabled || result.toInt32() !== 0) return;
        const f = this.frame, pts = f.add(136).readS64().toString(), key = this.ctx + ':' + pts;
        const packet = packets.get(key); if (packet) packets.delete(key);
        const frames = f.add(112).readS32(); if (frames < 1 || frames > 65536) return;
        if (!packet) {
            const info = contexts.get(this.ctx); if (!info) return;
            // Frames left in flight across flush/enable belong to the old
            // packet generation. Do not turn an unmatched FLAC frame into a
            // second PCM stream that replaces the just-sought source.
            if (info.encoded) return;
            const fmt = f.add(116).readS32(), formats = {0:['i16',1,false,false],1:['i16',2,false,false],2:['i32',4,false,false],3:['f32',4,false,true],4:['f64',8,false,true],5:['i16',1,true,false],6:['i16',2,true,false],7:['i32',4,true,false],8:['f32',4,true,true],9:['f64',8,true,true],...(force?{10:['f64',8,false,true],11:['f64',8,true,true]}:{})};
            const spec = formats[fmt];
            if (!spec) { if (lastUnsupported !== String(fmt)) { lastUnsupported = String(fmt); send({ event: 'error', message: '当前原生 PCM 样本排布尚不支持：' + fmt }); } return; }
            const [pcmFormat, width, planar, float] = spec, bytes = frames * info.channels * width;
            if (bytes > 2 * 1024 * 1024) { send({ event: 'error', message: '原生 PCM 包超过内存预算' }); return; }
            let data;
            if (planar) {
                const joined = new Uint8Array(bytes);
                for (let ch=0;ch<info.channels;ch++) joined.set(new Uint8Array(f.add(ch*8).readPointer().readByteArray(frames*width)),ch*frames*width);
                data = joined.buffer;
            } else data = f.readPointer().readByteArray(bytes);
            const converted = fmt === 10 || fmt === 11;
            if (fmt === 0 || fmt === 5) {
                const input = new Uint8Array(data), output = new Int16Array(input.length);
                for(let i=0;i<input.length;i++) output[i]=(input[i]-128)*256;
                data=output.buffer;
            } else if (converted) {
                const input = new DataView(data), output = new Float64Array(bytes/8);
                for(let i=0;i<output.length;i++) output[i]=Number(input.getBigInt64(i*8,true))/9223372036854775808;
                data=output.buffer;
            }
            let clock = null;
            if (info.numerator > 0 && info.denominator > 0) clock = (BigInt(pts) * BigInt(info.numerator) * BigInt(info.sampleRate) / BigInt(info.denominator)).toString();
            if (clock === null && info.codec === 'flac') clock = pts;
            count++;
            send({ event: 'audio', ...info, encoding: 'pcm', pcmFormat, planar, float, converted, pts: clock, rawPts: pts, frames }, data);
            return;
        }
        count++;
        send({ event: 'audio', ...packet.info, encoding: 'flac', float: false, pts, frames }, packet.data);
    }
}));
for (const fn of ['avcodec_flush_buffers', 'avcodec_open2']) {
    hooks.push(Interceptor.attach(codec.getExportByName(fn), {
        onEnter(args) { contexts.delete(args[0].toString()); packets.clear(); }
    }));
}
hooks.push(Interceptor.attach(codec.getExportByName('avcodec_free_context'), {
    onEnter(args) {
        if(args[0].isNull())return;
        const ctx=args[0].readPointer().toString();
        contexts.delete(ctx);
        for(const key of packets.keys())if(key.startsWith(ctx+':'))packets.delete(key);
    }
}));
rpc.exports = {
    enable(value) { enabled = !!value; if (!enabled) packets.clear(); },
    snapshot() { return { packets: count, contexts: contexts.size, enabled }; },
    stop() { enabled = false; packets.clear(); for (const h of hooks) h.detach(); }
};
send({ event: 'audioReady', codec: 'flac', path: 'encodedBeforeDsp' });
