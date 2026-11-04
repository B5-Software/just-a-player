import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Script, Session } from 'frida'
import type { ExternalAction, ExternalDevice, ExternalPlayerState, ExternalSnapshot } from '../shared/external-player'
import type { TrackInfo } from '../shared/protocol/TrackInfo'
import type { SampleFormat } from '../shared/protocol/SampleFormat'
import type { Event } from '../shared/protocol/Event'
import { MAX_COVER_BYTES, rasterCover, responseCover } from './external-cover'
import audioAgent from './external/netease-audio.js?raw'
import rendererAgent from './external/netease-renderer.js?raw'
import virtualAgent from './external/virtual-output.js?raw'

interface LiveEngine {
  send(command: string): void
  openLive(config: string): void
  pushLive(pts: number, frames: number, data: Buffer): void
  closeLive(): void
}
interface AudioPacket {
  event: 'audio'; stream: number; pts: string | null; rawPts?: string; frames: number
  codec: string; encoding: 'flac' | 'pcm'; pcmFormat?: SampleFormat; planar?: boolean; float: boolean; converted?: boolean
  sampleRate: number; channels: number; bits: number | null; streaminfo: number[] | null
}
const EMPTY = (): ExternalPlayerState => ({ phase: 'disconnected', message: '', snapshot: null, path: null, cover: null, audioPackets: 0, nullBytes: '0' })
const NULL_NAME = 'Just A Player HiFi Bridge (Black Hole)'
const exec = promisify(execFile)

/** An explicit, local connection to one verified NetEase desktop client. */
export class ExternalPlayer {
  private state = EMPTY()
  private sessions: Session[] = []
  private scripts: Script[] = []
  private renderer: Script | null = null
  private audio: Script | null = null
  private virtual: Script | null = null
  private previousDevice: ExternalDevice | null = null
  private fallbackDevice = false
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private pollFailures = 0
  private lastSnapshotAt = 0
  private lastAudioAt = 0
  private transitionAt = 0
  private resumeCapture: Promise<void> | null = null
  private recovering = false
  private lastForce = false
  private closing = false
  private disconnecting: Promise<void> | null = null
  private stream = ''
  private nextFrame = 0
  private clockKey = ''
  private previousRawPts: number | null = null
  private lastSourceStream = 0
  private seekTargetMs: number | null = null
  private seekStreamFloor = 0
  private engineStopped = true
  private audiblePositionMs = 0
  private lastSeekAt = 0
  private readonly stopWaiters = new Set<() => void>()
  private coverGeneration = 0
  private coverUrl = ''
  private coverLoading = false
  private coverAttempts = 0
  private coverRetryAt = 0
  private coverAbort: AbortController | null = null
  private lastNativeState = ''
  private capturePaused = false
  private controlSequence = 0
  private lastAck = 0
  private readonly awaiting = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private pendingAudio: { packet: AudioPacket; data: Buffer; at: number }[] = []

  constructor(private readonly engine: LiveEngine, private readonly dllPath: string, private readonly publish: (state: ExternalPlayerState) => void, private readonly readLocalCover?: (path: string) => { mime: string; data: Uint8Array } | null) {}
  get connected(): boolean { return !!this.renderer && !this.closing }
  get routing(): boolean { return this.state.phase === 'routing' }
  get ownsTransport(): boolean { return this.routing || (this.connected && this.state.snapshot?.devices?.currentDevice.name === NULL_NAME) }
  snapshot(): ExternalPlayerState { return this.state }
  engineEvent(event: Event): void {
    if (event.type === 'position') this.audiblePositionMs = event.positionMs
    if (event.type === 'state') {
      this.engineStopped = event.state === 'stopped'
      if (this.engineStopped) for (const done of [...this.stopWaiters]) done()
    }
    // A failed library probe/analysis is unrelated to this live transport.
    if (event.type === 'error' && this.routing && !this.closing && /输出设备中断|output device|live input|实时流.*(?:错误|失败)/i.test(event.message)) void this.fail(event.message)
    if (event.type === 'bufferReset' && event.automatic && this.routing && !this.closing && !this.capturePaused && Date.now() - this.lastSeekAt > 1500)
      void this.action('seek', this.audiblePositionMs).catch(error => this.fail(String(error)))
  }
  private async stopRust(): Promise<void> {
    this.engine.closeLive()
    if (this.engineStopped && !this.stream) { this.engine.send(JSON.stringify({ type: 'stop' })); return }
    await new Promise<void>((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); this.stopWaiters.delete(done); resolve() }
      const timer = setTimeout(() => { this.stopWaiters.delete(done); reject(new Error('Rust 输出尚未释放，未切回客户端物理设备')) }, 2500)
      this.stopWaiters.add(done)
      this.engine.send(JSON.stringify({ type: 'stop' }))
    })
    this.stream = ''
  }
  private rpc(script: Script | null, name: string, ...args: unknown[]): Promise<unknown> {
    const fn = script?.exports[name]
    if (!fn) return Promise.reject(new Error(`外部播放器接口 ${name} 不可用`))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`外部播放器接口 ${name} 响应超时`)), 6000)
      Promise.resolve(fn(...args)).then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }
  private update(patch: Partial<ExternalPlayerState>): void {
    const previous = this.state
    this.state = { ...this.state, ...patch }
    const snapshot = this.state.snapshot
    this.publish({ ...this.state,
      snapshot: snapshot && snapshot.queue === previous.snapshot?.queue ? {...snapshot,queue:undefined} : snapshot,
      cover: 'cover' in patch ? this.state.cover : undefined })
  }

  async action(action: ExternalAction, positionMs?: number, force = false): Promise<ExternalPlayerState> {
    const control = ['pause','resume','seek','next','previous'].includes(action) ? ++this.controlSequence : this.controlSequence
    if (action === 'connect') { this.recovering = false; await this.connect(force) }
    else if (action === 'disconnect') { this.recovering = false; await this.disconnect() }
    else if (action === 'route') {
      await this.command('devices')
      const findDevice = (): ExternalDevice | undefined => this.state.snapshot?.devices?.totalDevices.flatMap(g => g.devices).find(d => d.name === NULL_NAME && d.type === 'DirectSound')
      const deadline = Date.now() + 4000
      while (!findDevice() && this.connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
      const device = findDevice()
      if (!device) throw new Error('网易云尚未枚举到虚拟输出，请稍后重试')
      await this.stopRust()
      await this.command('device', { device })
      const switchedBy = Date.now() + 4000
      while (this.state.snapshot?.devices?.currentDevice.name !== NULL_NAME && this.connected && Date.now() < switchedBy) {
        await this.command('devices')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (this.state.snapshot?.devices?.currentDevice.name !== NULL_NAME) throw new Error('尚未确认客户端已切换到黑洞设备')
    } else if (action !== 'status') {
      if (!this.connected) throw new Error('外部播放器未连接')
      if (action === 'pause') {
        this.capturePaused = true
        this.pendingAudio = []
        this.engine.send(JSON.stringify({ type: 'pause' }))
        await this.rpc(this.audio, 'enable', false)
      }
      if (action === 'resume' && this.capturePaused) {
        const position = this.state.snapshot?.positionMs ?? 0
        this.prepareSeek(position)
        await this.rpc(this.audio, 'enable', true)
        this.capturePaused = false
        await this.command('resume')
        if (control === this.controlSequence) await this.action('seek', position)
        return this.state
      }
      if (action === 'seek') {
        this.prepareSeek(positionMs ?? 0)
      }
      await this.command(action, action === 'seek' || action === 'playIndex' ? { positionMs } : {})
    }
    return this.state
  }
  private prepareSeek(position: number): void {
    this.transitionAt = 0
    this.lastSeekAt = Date.now()
    this.seekTargetMs = Math.max(0, position); this.seekStreamFloor = this.lastSourceStream
    this.pendingAudio = []
    this.engine.send(JSON.stringify({ type: 'stop' })); this.engine.closeLive(); this.stream = ''
  }

  private bufferAudio(packet: AudioPacket, data: Buffer, at: number): void {
    // Keep next-track read-ahead across the slower CEF metadata poll. This is a
    // bounded handoff buffer, not a saved copy of the song.
    this.pendingAudio = this.pendingAudio.filter(p => Date.now() - p.at < 5000)
    const bytes = this.pendingAudio.reduce((sum, p) => sum + p.data.byteLength, 0)
    if (this.pendingAudio.length < 96 && bytes + data.byteLength <= 16 * 1024 * 1024)
      this.pendingAudio.push({ packet, data, at })
  }

  private enableCapture(position: number): void {
    if (this.resumeCapture) return
    this.resumeCapture = this.rpc(this.audio, 'enable', true).then(() => {
      this.capturePaused = false
      return this.action('seek', position).then(() => {})
    }).catch(error => { if (!this.closing) this.update({ message: String(error) }) })
      .finally(() => { this.resumeCapture = null })
  }

  private async command(action: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.renderer) throw new Error('网易云控制通路未连接')
    const id = Number(await this.rpc(this.renderer, 'command', { action, ...extra }))
    if (this.lastAck >= id) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.awaiting.delete(id); reject(new Error(`网易云未确认控制指令 ${action}`)) }, 3000)
      this.awaiting.set(id, { resolve, reject, timer })
    })
  }

  private async connect(force: boolean): Promise<void> {
    if (this.disconnecting) await this.disconnecting
    if (this.connected || this.state.phase === 'connecting') return
    if (process.platform !== 'win32') throw new Error('此客户端适配器目前支持 Windows 网易云音乐 3.1.41 x64')
    if (!existsSync(this.dllPath)) throw new Error('缺少原生虚拟输出模块，请重新构建或安装播放器')
    this.closing = false
    this.lastForce = force
    this.update({ ...EMPTY(), phase: 'connecting', message: '正在连接网易云音乐…' })
    try {
      const frida = await import('frida')
      // The client pins its COM implementation until exit. Load a content-named
      // copy so an installer/build can update the application's DLL meanwhile.
      const hash = createHash('sha256').update(readFileSync(this.dllPath)).digest('hex').slice(0, 24)
      const shadowDirectory = join(tmpdir(), 'just-a-player-bridge', hash)
      const shadow = join(shadowDirectory, 'jap_virtual_output.dll')
      mkdirSync(shadowDirectory, { recursive: true })
      if (!existsSync(shadow)) copyFileSync(this.dllPath, shadow)
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter \"Name='cloudmusic.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
      const raw = JSON.parse(stdout || '[]') as { ProcessId: number; CommandLine: string }[] | { ProcessId: number; CommandLine: string }
      const processes = Array.isArray(raw) ? raw : [raw]
      const main = processes.find(p => p.CommandLine && !p.CommandLine.includes('--type='))
      const renderer = processes.find(p => p.CommandLine?.includes('--type=renderer'))
      if (!main || !renderer) throw new Error('请先启动网易云音乐并进入播放器')
      const mainSession = await frida.attach(main.ProcessId)
      this.sessions.push(mainSession)
      const rendererSession = await frida.attach(renderer.ProcessId)
      this.sessions.push(rendererSession)
      for (const s of this.sessions) s.detached.connect(() => { if (!this.closing && this.sessions.includes(s)) void this.recoverConnection() })
      this.virtual = await mainSession.createScript(virtualAgent.replace('__DLL_PATH__', JSON.stringify(shadow)))
      this.audio = await mainSession.createScript(audioAgent.replace('__FORCE__', String(force)))
      this.renderer = await rendererSession.createScript(rendererAgent.replace('__FORCE__', String(force)))
      this.scripts = [this.virtual, this.audio, this.renderer]
      for (const script of this.scripts) {
        script.message.connect((message, data) => {
          if (message.type === 'error') { void this.fail(message.description); return }
          if (message.type !== 'send') return
          const payload = message.payload as Record<string, unknown>
          if (payload.event === 'error') {
            if (script === this.renderer) this.update({ message: String(payload.message) })
            else void this.fail(String(payload.message))
          }
          else if (payload.event === 'snapshot') this.onSnapshot(payload.value as ExternalSnapshot)
          else if (payload.event === 'audio' && data) this.onAudio(payload as unknown as AudioPacket, data)
          else if (payload.event === 'unsupported' && this.routing) void this.fail(`当前客户端流编码 ${String(payload.codec)} 尚未验证，已停止接管`)
        })
        await script.load()
      }
      const initializationDeadline = Date.now() + 20000
      while (!this.state.snapshot && Date.now() < initializationDeadline && !this.closing) await new Promise(resolve => setTimeout(resolve, 100))
      if (!this.state.snapshot) throw new Error('尚未取得客户端脚本上下文，请确认播放器已加载')
      await this.command('devices')
      this.update({ phase: 'ready', message: force ? '已强制连接并添加虚拟设备；选择它后开始路由' : '已添加客户端虚拟设备；选择它后开始路由' })
      this.timer = setInterval(() => { void this.poll() }, 500)
      await this.rpc(this.audio, 'enable', true)
    } catch (error) {
      await this.disconnect(false)
      this.update({ phase: 'error', message: String(error) })
      throw error
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.closing || !this.virtual) return
    this.polling = true
    try {
      const stats = await this.rpc(this.virtual, 'snapshot') as { creations: number; buffers: number; discardedBytes: string }
      this.update({ nullBytes: stats.discardedBytes })
      await this.command('devices')
      this.pollFailures = 0
      if (this.routing && this.state.snapshot?.state === 'playing') {
        if (this.capturePaused) this.enableCapture(this.state.snapshot.positionMs)
        // A missed start packet must not strand the next song forever. Ask the
        // source to regenerate from the current audible position, without
        // detaching the hooks or switching physical output devices.
        if (Date.now() - this.lastAudioAt > 8000 && Date.now() - this.lastSeekAt > 8000)
          await this.action('seek', this.state.snapshot.positionMs)
      }
      if (stats.buffers > 0 && this.state.snapshot?.devices?.currentDevice.name === NULL_NAME && !this.routing) {
        this.stream = ''; this.engine.send(JSON.stringify({ type: 'stop' }))
        this.update({ phase: 'routing', message: '客户端输出已进入黑洞，正在接收音频…' })
        // Re-read from the audible source position instead of skipping its decoder read-ahead.
        await this.action('seek', this.state.snapshot.positionMs)
      } else if (this.routing && this.state.snapshot?.devices?.currentDevice.name !== NULL_NAME) {
        this.engine.send(JSON.stringify({ type: 'stop' })); this.engine.closeLive(); this.stream = ''
        this.update({ phase: 'ready', message: '客户端已切回其他设备，Rust 路由已停止' })
      }
    } catch (error) {
      if (!this.closing) {
        this.pollFailures++
        this.update({ message: `连接暂时繁忙，正在重试（${this.pollFailures}）` })
        if (this.pollFailures >= 4 && Date.now() - this.lastSnapshotAt > 20000) await this.fail(String(error))
      }
    }
    finally { this.polling = false }
  }

  private onSnapshot(value: ExternalSnapshot): void {
    if (!value.found) return
    if (value.queue === undefined && this.state.snapshot?.queue) value = {...value,queue:this.state.snapshot.queue}
    if (this.closing) { this.state = { ...this.state, snapshot: value }; return }
    for (const id of value.acks) {
      this.lastAck = Math.max(this.lastAck, id)
      const pending = this.awaiting.get(id)
      if (pending) { clearTimeout(pending.timer); pending.resolve(); this.awaiting.delete(id) }
    }
    if (!this.previousDevice && value.devices) {
      const backup = join(tmpdir(), 'just-a-player-netease-output.json')
      const current = value.devices.currentDevice
      if (current.name !== NULL_NAME) {
        this.previousDevice = current
        try { writeFileSync(backup, JSON.stringify(current), {mode:0o600}) } catch { /* Best-effort crash recovery. */ }
      } else {
        // The previous host may have crashed while the client retained its
        // black-hole selection. Recover the last verified real device first.
        const devices = value.devices.totalDevices.flatMap(group => group.devices).filter(device => device.name !== NULL_NAME)
        let saved: ExternalDevice | null = null
        try { if (statSync(backup).size < 16384) saved = JSON.parse(readFileSync(backup,'utf8')) } catch {}
        this.previousDevice = devices.find(device => saved && device.type === saved.type && device.name === saved.name && device.deviceId === saved.deviceId) ?? null
        if (!this.previousDevice) {
          this.previousDevice = devices.find(device => device.type === 'DirectSound') ?? devices.find(device => device.type === 'Wasapi' && device.id === 0) ?? null
          this.fallbackDevice = this.previousDevice !== null
        }
      }
    }
    this.lastSnapshotAt = Date.now()
    const previous = this.state.snapshot
    const oldId = previous?.track.id
    this.update({ snapshot: value })
    const repeated = previous && previous.track.durationMs > 0 && previous.positionMs > previous.track.durationMs - 2500 && value.positionMs < 1000
    if (oldId && (oldId !== value.track.id || repeated) && this.routing) {
      const activeGeneration = Number(this.stream.split(':')[1]) || 0
      this.engine.closeLive(); this.stream = ''; this.nextFrame = 0
      this.seekTargetMs = 0; this.seekStreamFloor = activeGeneration
      this.transitionAt = Date.now(); this.lastSeekAt = Date.now()
      this.clockKey = ''; this.previousRawPts = null
      // Natural EOF is owned by NetEase. Do not issue another next/seek from
      // our local queue. Start with buffered packets from its next decoder.
    }
    else if (previous && oldId === value.track.id && this.routing && !this.capturePaused && this.seekTargetMs === null && previous.positionMs - value.positionMs > 1500) {
      this.prepareSeek(value.positionMs)
      void this.command('seek',{positionMs:value.positionMs}).catch(error => this.update({message:String(error)}))
    }
    if (this.routing && value.state !== this.lastNativeState) {
      if (value.state === 'paused') {
        this.capturePaused = true
        this.pendingAudio = []
        this.engine.send(JSON.stringify({ type: 'pause' }))
        void this.rpc(this.audio, 'enable', false).catch(error => this.fail(String(error)))
      } else if (value.state === 'playing' && this.capturePaused) {
        this.enableCapture(value.positionMs)
      } else if (value.state === 'playing') this.engine.send(JSON.stringify({ type: 'resume' }))
      else {
        // A stopped snapshot also occurs between songs while NetEase loads the
        // next resource. Keep capture armed, including its early read-ahead.
        this.engine.closeLive(); this.stream = ''
      }
    }
    this.lastNativeState = value.state
    const coverKey = `${value.track.id}|${value.track.localPath ?? ''}|${value.track.coverUrl}`
    const changedCover = coverKey !== this.coverUrl
    if (changedCover) {
      this.coverAbort?.abort(); this.coverGeneration++
      this.coverUrl = coverKey; this.coverLoading = false; this.coverAttempts = 0; this.coverRetryAt = 0
    }
    if (!this.coverLoading && (changedCover || (!this.state.cover && Date.now() >= this.coverRetryAt)) && (value.track.coverUrl || value.track.localPath))
      void this.loadCover(value.track.coverUrl, value.track.localPath)
    const pending = this.pendingAudio.splice(0)
    for (const p of pending) if (Date.now() - p.at < 5000) this.onAudio(p.packet, p.data, p.at)
  }

  private onAudio(p: AudioPacket, data: Buffer, receivedAt = Date.now()): void {
    this.lastSourceStream = Math.max(this.lastSourceStream, p.stream)
    const s = this.state.snapshot
    if (!this.routing || !s?.track.id || this.closing || this.capturePaused) return
    if (s.speed !== 1) { void this.fail('路由模式需要客户端使用 1× 播放速度'); return }
    const key = `${s.track.id}:${p.stream}:${p.encoding}:${p.pcmFormat ?? ''}`
    let pts: number
    if (p.pts === null) {
      const raw = Number(p.rawPts)
      const continuous = this.clockKey === key && this.previousRawPts !== null && raw > this.previousRawPts
      pts = continuous ? this.nextFrame : Math.round(s.positionMs * p.sampleRate / 1000)
      this.clockKey = key; this.previousRawPts = raw
    } else pts = Number(p.pts)
    if (!Number.isSafeInteger(pts) || pts < 0) { void this.fail('客户端提供了不可验证的时间戳'); return }
    if (s.state === 'stopped' && !this.stream) { this.bufferAudio(p, data, receivedAt); return }
    if (this.stream && key !== this.stream) {
      if (p.stream > Number(this.stream.split(':')[1])) this.bufferAudio(p, data, receivedAt)
      return
    }
    let trimStartFrames = 0
    if (this.seekTargetMs !== null) {
      const target = Math.round(this.seekTargetMs * p.sampleRate / 1000)
      const seekAcknowledged = Math.abs(s.positionMs - this.seekTargetMs) <= 1100
      if (p.stream <= this.seekStreamFloor && !(seekAcknowledged && pts !== this.nextFrame && !this.transitionAt)) return
      if (pts + p.frames <= target) return
      // A decoder can finish old read-ahead after a seek. Only the packet
      // containing the requested sample may establish the new timeline.
      if (pts > target) return
      trimStartFrames = Math.max(0, target - pts)
    }
    if (this.stream && pts !== this.nextFrame) {
      // Duplicate/late packets and other decoder contexts do not replace the
      // active stream. A gap in that stream asks the source to resynchronize.
      if (pts > this.nextFrame && key === this.stream && Date.now() - this.lastSeekAt > 1500)
        void this.action('seek', this.audiblePositionMs).catch(error => this.fail(String(error)))
      return
    }
    if (pts * 1000 / p.sampleRate + 2000 < s.positionMs) {
      this.bufferAudio(p, data, receivedAt)
      return
    }
    this.seekTargetMs = null
    this.transitionAt = 0
    try {
      if (key !== this.stream || pts !== this.nextFrame) {
        const path = `external://netease/${encodeURIComponent(s.track.id)}`
        const lossless = !p.converted && /^(flac|alac|wavpack|ape|pcm_)/i.test(p.codec)
        const containerBits = p.pcmFormat === 'i16' ? 16 : p.pcmFormat === 'f64' ? 64 : 32
        const track: TrackInfo = { path, codec: `网易云 / ${p.codec.toUpperCase()} · ${p.encoding === 'flac' ? '原始压缩包' : '原生解码 PCM'}${p.converted ? ' · 64 位整数→浮点（有精度损失）' : ''}${p.pts === null ? ' · 估计时钟' : ''}`, format: { sampleRate: p.sampleRate, channels: p.channels, bits: lossless ? p.bits ?? containerBits : null, float: p.float }, durationMs: s.track.durationMs, lossless, bitrateKbps: null, title: s.track.title, artist: s.track.artist, album: s.track.album }
        this.engine.openLive(JSON.stringify({ track, encoding: p.encoding === 'flac' ? { type: 'flac', streaminfo: p.streaminfo } : { type: 'pcm', format: p.pcmFormat, planar: p.planar }, startFrame: pts, trimStartFrames }))
        this.engineStopped = false
        this.stream = key
        this.update({ path, message: p.encoding === 'flac' ? '原始 FLAC → Rust；客户端最终输出进入黑洞' : `${p.codec.toUpperCase()} 原生解码 PCM → Rust；客户端最终输出进入黑洞` })
      }
      this.engine.pushLive(pts, p.frames, data)
      this.lastAudioAt = Date.now()
      this.nextFrame = pts + p.frames
      this.state = { ...this.state, audioPackets: this.state.audioPackets + 1 }
      if (s.state === 'paused') this.engine.send(JSON.stringify({ type: 'pause' }))
    } catch (error) { void this.fail(String(error)) }
  }

  private async loadCover(raw: string, localPath?: string): Promise<void> {
    const generation = ++this.coverGeneration
    this.coverLoading = true
    const abort = new AbortController()
    this.coverAbort = abort
    try {
      if (localPath && this.readLocalCover) {
        const cover = this.readLocalCover(localPath)
        if (cover && cover.data.length <= MAX_COVER_BYTES) {
          if (generation === this.coverGeneration && !this.closing) this.update({ cover })
          return
        }
      }
      const embedded = /^data:image\/(?:jpe?g|png|webp);base64,([a-z0-9+/=]+)$/i.exec(raw)
      if (embedded && embedded[1]!.length <= 12 * 1024 * 1024) {
        const cover = rasterCover(Buffer.from(embedded[1]!, 'base64'))
        if (generation === this.coverGeneration && !this.closing) this.update({ cover })
        return
      }
      const url = new URL(raw)
      if (!['http:', 'https:'].includes(url.protocol) || !/^(?:p\d+\.)?music\.126\.net$/.test(url.hostname)) throw new Error('封面地址不在已验证的图片域名范围内')
      url.protocol = 'https:'
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]) })
      const cover = await responseCover(response)
      if (generation === this.coverGeneration && !this.closing) this.update({ cover })
    } catch {
      if (generation === this.coverGeneration && !this.closing) {
        this.coverRetryAt = Date.now() + Math.min(30000, 1000 * 3 ** Math.min(this.coverAttempts++, 4))
        this.update({ cover: null })
      }
    } finally {
      if (generation === this.coverGeneration) { this.coverLoading = false; this.coverAbort = null }
    }
  }

  private async fail(message: string): Promise<void> {
    if (this.closing) return
    await this.disconnect()
    this.update({ phase: 'error', message })
  }

  private async recoverConnection(): Promise<void> {
    if (this.recovering || this.closing) return
    const route = this.ownsTransport, playing = this.state.snapshot?.state === 'playing', force = this.lastForce
    this.recovering = true
    await this.disconnect(false)
    for (let attempt = 1; attempt <= 3 && this.recovering; attempt++) {
      this.update({ phase: 'connecting', message: `正在恢复网易云连接（${attempt}/3）…` })
      await new Promise(resolve => setTimeout(resolve, attempt * 1000))
      if (!this.recovering) return
      // connect() treats a connecting phase as an existing attempt.
      this.state.phase = 'disconnected'
      try {
        await this.connect(force)
        if (!this.recovering) return
        if (route) { await this.action('route'); if (playing) await this.action('resume') }
        this.recovering = false
        return
      } catch { /* A restarting renderer may not be ready yet. */ }
    }
    if (this.recovering) this.update({ phase: 'error', message: '网易云连接未恢复，请确认客户端仍在运行后重试。' })
    this.recovering = false
  }

  async disconnect(cancelRecovery = true): Promise<void> {
    if (cancelRecovery) this.recovering = false
    if (this.disconnecting) return this.disconnecting
    const closing = this.closeConnection()
    this.disconnecting = closing
    try { await closing }
    finally { if (this.disconnecting === closing) this.disconnecting = null }
  }

  private async closeConnection(): Promise<void> {
    this.closing = true
    for (const p of this.awaiting.values()) { clearTimeout(p.timer); p.reject(new Error('外部播放器连接已关闭')) }
    this.awaiting.clear(); this.lastAck = 0
    if (this.timer) clearInterval(this.timer)
    this.timer = null; this.coverGeneration++; this.coverAbort?.abort(); this.coverAbort = null
    this.coverLoading = false; this.coverAttempts = 0; this.coverRetryAt = 0; this.pendingAudio = []
    let released = true
    if (this.renderer && this.state.snapshot?.devices?.currentDevice.name === NULL_NAME) {
      try {
        await this.rpc(this.renderer, 'command', { action: 'pause' })
        const pausedBy = Date.now() + 1500
        while (this.state.snapshot?.state === 'playing' && Date.now() < pausedBy) await new Promise(resolve => setTimeout(resolve, 100))
      } catch { /* A terminating client has already stopped its output. */ }
    }
    if (this.state.phase === 'routing') {
      try { await this.stopRust() } catch { released = false }
    } else this.engine.closeLive()
    let restoreFailed = false, restored = ''
    try {
      if (released && this.renderer && this.previousDevice && this.state.snapshot?.devices?.currentDevice.name === NULL_NAME) {
        await this.rpc(this.renderer, 'command', { action: 'device', device: this.previousDevice })
        const deadline = Date.now() + 3500
        let confirmed = false
        while (Date.now() < deadline) {
          await this.rpc(this.renderer, 'command', { action: 'devices' })
          await new Promise(resolve => setTimeout(resolve, 200))
          const device = this.state.snapshot?.devices?.currentDevice
          if (device?.type === this.previousDevice.type && device.name === this.previousDevice.name) { confirmed = true; restored = device.name; break }
        }
        restoreFailed = !confirmed
      }
      if (!released) restoreFailed = true
      if (!this.previousDevice && this.state.snapshot?.devices?.currentDevice.name === NULL_NAME) restoreFailed = true
    } catch { restoreFailed = true /* A terminating client cannot be controlled. */ }
    for (const script of [...this.scripts].reverse()) { try { await this.rpc(script, 'stop'); await script.unload() } catch {} }
    for (const session of this.sessions) { try { await session.detach() } catch {} }
    this.scripts = []; this.sessions = []; this.renderer = this.audio = this.virtual = null
    const fallback = this.fallbackDevice
    this.previousDevice = null; this.fallbackDevice = false; this.stream = ''; this.nextFrame = 0; this.coverUrl = ''; this.lastNativeState = ''
    this.capturePaused = false
    this.pollFailures = 0; this.lastSnapshotAt = 0; this.lastAudioAt = 0; this.transitionAt = 0; this.resumeCapture = null
    this.audiblePositionMs = 0; this.lastSeekAt = 0
    this.clockKey = ''; this.previousRawPts = null; this.lastSourceStream = 0; this.seekTargetMs = null; this.seekStreamFloor = 0
    this.update({ ...EMPTY(), ...(restoreFailed ? { phase: 'error', message: '连接已关闭；未确认客户端输出恢复，请在网易云中检查输出设备。' } : { message: restored ? `已断开，客户端输出已恢复到 ${restored}${fallback ? '（原设备记录不可用，使用系统默认）' : ''}` : '' }) }); this.closing = false
  }
}
