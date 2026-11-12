import { externalSystemMedia } from '@jap/engine'
import type { ExternalAction, ExternalPlayerState } from '../shared/external-player'
import type { Event } from '../shared/protocol/Event'
import { rasterCover } from './external-cover'
import { ExternalPlayer } from './external-player'

const EMPTY: ExternalPlayerState = {
  source: 'system-media', phase: 'ready', snapshot: null, message: '',
  path: null, cover: null, audioPackets: 0, nullBytes: '0'
}
const WAITING = '等待网易云发布系统媒体会话。请在客户端开始播放。'

export class ExternalConnection {
  private readonly client: ExternalPlayer
  private media: ExternalPlayerState | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private request = 0
  private sourceId: string | undefined
  private controlling = false

  constructor(
    engine: ConstructorParameters<typeof ExternalPlayer>[0],
    dllPath: string,
    private readonly publish: (state: ExternalPlayerState) => void,
    readCover: ConstructorParameters<typeof ExternalPlayer>[3]
  ) {
    this.client = new ExternalPlayer(engine, dllPath, state => {
      if (!this.media) this.publish(state)
    }, readCover)
  }

  get connected(): boolean { return this.client.connected }
  get ownsTransport(): boolean { return this.client.ownsTransport }
  snapshot(): ExternalPlayerState { return this.media ?? this.client.snapshot() }
  engineEvent(event: Event): void { this.client.engineEvent(event) }

  async action(action: ExternalAction, positionMs?: number, force?: boolean): Promise<ExternalPlayerState> {
    if (action === 'connectSystem') {
      if (process.platform !== 'win32') throw new Error('系统媒体连接仅在 Windows 可用')
      if (this.media) return this.media
      if (this.client.snapshot().phase !== 'disconnected') await this.client.disconnect()
      this.media = { ...EMPTY, message: WAITING }
      this.publish(this.media)
      void this.poll(++this.generation)
      return this.media
    }
    if (!this.media) return this.client.action(action, positionMs, force)
    if (action === 'connect' || action === 'disconnect') {
      await this.disconnect()
      if (action === 'connect') return this.client.action(action, positionMs, force)
      return this.snapshot()
    }
    if (action === 'status') return this.media
    if (action !== 'pause' && action !== 'resume' && action !== 'next' && action !== 'previous')
      throw new Error('此操作在系统媒体连接中不可用')
    if (!this.sourceId || this.controlling) return this.media
    const generation = this.generation
    this.controlling = true
    try { await this.refresh(generation, action) }
    finally { if (generation === this.generation) this.controlling = false }
    return this.snapshot()
  }

  async disconnect(): Promise<void> {
    if (!this.media) return this.client.disconnect()
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.media = null
    this.sourceId = undefined
    this.controlling = false
    this.publish(this.client.snapshot())
  }

  private async poll(generation: number): Promise<void> {
    try {
      if (!this.controlling) await this.refresh(generation, 'status')
    } catch {
      this.clearSession(generation, '无法读取 Windows 媒体会话，稍后自动重试。')
    }
    if (this.media && generation === this.generation) {
      this.timer = setTimeout(() => { void this.poll(generation) }, 1000)
    }
  }

  private clearSession(generation: number, message: string): void {
    if (!this.media || generation !== this.generation) return
    if (!this.media.snapshot && this.media.message === message) return
    this.sourceId = undefined
    this.media = { ...EMPTY, message }
    this.publish(this.media)
  }

  private async refresh(generation: number, action: string): Promise<void> {
    const request = ++this.request
    const knownCover = this.media?.cover ? this.media.snapshot?.track.id : undefined
    const result = await externalSystemMedia(action, this.sourceId, knownCover)
    if (!this.media || generation !== this.generation || request !== this.request) return
    if (!result) { this.clearSession(generation, WAITING); return }
    this.sourceId = result.sourceId
    let cover = result.trackKey === this.media.snapshot?.track.id ? this.media.cover : null
    if (result.cover) {
      try { cover = rasterCover(result.cover) } catch { /* Optional artwork may be unavailable. */ }
    }
    const next: ExternalPlayerState = {
      ...EMPTY,
      cover,
      controls: { play: result.canPlay, pause: result.canPause, next: result.canNext, previous: result.canPrevious },
      snapshot: {
        found: true,
        acks: [],
        track: {
          id: result.trackKey, title: result.title, artist: result.artist, album: result.album,
          durationMs: result.durationMs, coverUrl: ''
        },
        state: result.state === 'playing' || result.state === 'paused' ? result.state : 'stopped',
        positionMs: result.positionMs,
        speed: result.state === 'playing' ? 1 : 0,
        lyrics: { trackId: '', type: '', offset: 0, lines: [], translation: [], romanization: [], yrc: '' },
        devices: null,
        deviceError: null
      }
    }
    const sameCover = this.media.cover === cover
    this.media = next
    this.publish({ ...next, cover: sameCover ? undefined : cover })
  }
}
