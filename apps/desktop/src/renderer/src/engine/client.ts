import type { Command } from '@shared/protocol/Command'
import type { Event } from '@shared/protocol/Event'
import type { Query } from '@shared/protocol/Query'
import type { QueryResponse } from '@shared/protocol/QueryResponse'
import { IPC, type CoverPayload, type HostToRenderer, type RendererToHost } from '@shared/ipc'

type EventListener = (event: Event) => void
type VizListener = (frame: Float32Array) => void

/** 与引擎宿主之间的 MessagePort 通道；端口到达之前发出的消息会先排队。 */
class EngineClient {
  private port: MessagePort | null = null
  private nextId = 1
  private readonly pending = new Map<number, (response: QueryResponse) => void>()
  private readonly pendingCovers = new Map<number, (cover: CoverPayload | null) => void>()
  private readonly pendingOffline = new Map<
    number,
    {
      resolve: (value: Extract<HostToRenderer, { kind: 'offlineResult' }>) => void
      reject: (error: Error) => void
    }
  >()
  offline(
    action: 'open' | 'frame' | 'close' | 'original',
    options: {
      path?: string
      startMs?: number
      timeMs?: number
      writeAudio?: boolean
      soundfont?: string
      midiRate?: number
    } = {}
  ): Promise<Extract<HostToRenderer, { kind: 'offlineResult' }>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pendingOffline.set(id, { resolve, reject })
      this.post({ kind: 'offline', id, action, ...options })
    })
  }
  private readonly listeners = new Set<EventListener>()
  private readonly vizListeners = new Set<VizListener>()
  private readonly backlog: RendererToHost[] = []
  private readonly connectListeners = new Set<() => void>()

  attach(port: MessagePort): void {
    this.port?.close()
    this.port = port
    port.onmessage = (e: MessageEvent<HostToRenderer>) => this.receive(e.data)
    port.start()
    for (const message of this.backlog.splice(0)) port.postMessage(message)
    for (const fn of this.connectListeners) fn()
  }

  send(command: Command): void {
    this.post({ kind: 'command', command })
  }

  query(query: Query): Promise<QueryResponse> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.post({ kind: 'query', id, query })
    })
  }

  /** 读取文件内嵌的封面（引擎宿主里解析，字节经 MessagePort 传回）。 */
  cover(path: string): Promise<CoverPayload | null> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pendingCovers.set(id, resolve)
      this.post({ kind: 'cover', id, path })
    })
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 每收到一帧频谱/波形分析数据就回调（约 60 Hz），不经过 React。 */
  onViz(listener: VizListener): () => void {
    this.vizListeners.add(listener)
    return () => this.vizListeners.delete(listener)
  }

  /** 每次（重新）连上引擎时回调，页面热更新后也会触发。 */
  onConnect(listener: () => void): () => void {
    this.connectListeners.add(listener)
    if (this.port) listener()
    return () => this.connectListeners.delete(listener)
  }

  private post(message: RendererToHost): void {
    if (this.port) this.port.postMessage(message)
    else this.backlog.push(message)
  }

  private receive(message: HostToRenderer): void {
    switch (message.kind) {
      case 'offlineResult': {
        const pending = this.pendingOffline.get(message.id)
        if (message.error) pending?.reject(new Error(message.error))
        else pending?.resolve(message)
        this.pendingOffline.delete(message.id)
        break
      }
      case 'viz':
        for (const listener of this.vizListeners) listener(message.frame)
        break
      case 'event':
        for (const listener of this.listeners) listener(message.event)
        break
      case 'queryResult':
        this.pending.get(message.id)?.(message.response)
        this.pending.delete(message.id)
        break
      case 'coverResult':
        this.pendingCovers.get(message.id)?.(message.cover)
        this.pendingCovers.delete(message.id)
        break
    }
  }
}

export const engine = new EngineClient()

window.addEventListener('message', (e) => {
  if (e.source === window && e.data === IPC.enginePort && e.ports[0]) engine.attach(e.ports[0])
})
