import { Engine, readCover, vizLayout } from '@jap/engine'
import * as native from '@jap/engine'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostToRenderer, RendererToHost } from '../shared/ipc'
import type { Event } from '../shared/protocol/Event'
import { VIZ } from '../shared/viz'
import { ExternalPlayer } from './external-player'
import { externalLyrics } from '../renderer/src/external/lyrics'


export function createAudioRuntime(publish: (message: HostToRenderer) => void) {
const layout = vizLayout()
if (
  layout.bands !== VIZ.bands ||
  layout.waveLen !== VIZ.waveLen ||
  layout.gonioPoints !== VIZ.gonioPoints ||
  layout.headerLen !== VIZ.headerLen
) {
  console.error('[engine-host] 可视化帧布局与 shared/viz.ts 不一致', layout)
}

let offline: { frameAt(ms: number): Float32Array; close(): void } | null = null

/** 页面刷新后新连上的端口要能立刻拿到当前状态，所以缓存每类事件的最新一条。 */
const latest: Partial<Record<Event['type'], Event>> = {}
const REPLAYABLE: Event['type'][] = [
  'state',
  'trackChanged',
  'signalPath',
  'position',
  'dspChanged',
  'quality',
  'volume',
]

function post(message: HostToRenderer): void {
  publish(message)
}

let external: ExternalPlayer | null = null
let configured = false
const engine = new Engine((json: string) => {
  const event = JSON.parse(json) as Event
  external?.engineEvent(event)
  // The client owns advancement of its live queue. Closing/resetting an input
  // must not make the local library interpret temporary EOF as "next song".
  if (event.type === 'queueEnded' && latest.trackChanged?.type === 'trackChanged' && latest.trackChanged.track.path.startsWith('external://')) return
  if (REPLAYABLE.includes(event.type)) latest[event.type] = event
  post({ kind: 'event', event })
})
external = new ExternalPlayer(
  engine,
  process.env['JAP_VIRTUAL_OUTPUT_PATH'] || join(process.resourcesPath, 'virtual-output', 'jap_virtual_output.dll'),
  (state) => post({ kind: 'externalState', state: { ...state, lyricsText: state.snapshot ? externalLyrics(state.snapshot) : null } }),
  readCover
)

function onPortMessage(message: RendererToHost, reply: { postMessage(message: HostToRenderer): void }): void {
  const post = (value: HostToRenderer): void => reply.postMessage(value)
  if (message.kind === 'external') {
    void external!.action(message.action, message.positionMs, message.force).then(
      state => post({ kind: 'externalResult', id: message.id, state }),
      error => post({ kind: 'externalResult', id: message.id, error: String(error) })
    )
    return
  }
  if (message.kind === 'offline') {
    try {
      if (message.action === 'original') {
        const audioPath = join(mkdtempSync(join(tmpdir(), 'jap-render-source-')), 'source.audio')
        ;(
          native as unknown as { unwrapOriginalAudio(source: string, target: string): void }
        ).unwrapOriginalAudio(message.path!, audioPath)
        post({ kind: 'offlineResult', id: message.id, audioPath })
      } else if (message.action === 'open') {
        offline?.close()
        const audioPath =
          message.writeAudio === false
            ? ''
            : join(mkdtempSync(join(tmpdir(), 'jap-render-audio-')), 'audio.wav')
        const Renderer = (
          native as unknown as {
            OfflineRender: new (
              path: string,
              audioPath: string,
              startMs: number,
              soundfont?: string,
              midiRate?: number
            ) => NonNullable<typeof offline>
          }
        ).OfflineRender
        offline = new Renderer(
          message.path!,
          audioPath,
          message.startMs ?? 0,
          message.soundfont,
          message.midiRate
        )
        post({ kind: 'offlineResult', id: message.id, audioPath })
      } else if (message.action === 'frame')
        post({
          kind: 'offlineResult',
          id: message.id,
          frame: offline?.frameAt(message.timeMs ?? 0),
        })
      else {
        offline?.close()
        offline = null
        post({ kind: 'offlineResult', id: message.id })
      }
    } catch (error) {
      post({ kind: 'offlineResult', id: message.id, error: String(error) })
    }
    return
  }
  try {
    if (message.kind === 'command') {
      if (!configured && ['setOutput','setVolume','setDsp','play'].includes(message.command.type)) {
        configured = true
        post({kind:'hostReady',active:true})
      }
      if (external?.connected) {
        const command = message.command
        if (command.type === 'play') {
          void external.disconnect().then(() => engine.send(JSON.stringify(command)))
          return
        }
        if (command.type === 'queueNext' && external.ownsTransport) return
        if (external.ownsTransport && (command.type === 'resetBuffer' || command.type === 'setOutput')) {
          const position = (latest.position?.type === 'position' ? latest.position.positionMs : undefined) ?? external.snapshot().snapshot?.positionMs ?? 0
          if (command.type === 'setOutput') {
            engine.send(JSON.stringify({ type: 'stop' }))
            engine.send(JSON.stringify(command))
          }
          void external.action('seek', position).then(() => {
            if (command.type === 'resetBuffer') post({ kind: 'event', event: { type: 'bufferReset', automatic: false } })
          }).catch(error => post({ kind: 'event', event: { type: 'error', message: String(error) } }))
          return
        }
        if (external.ownsTransport && ['pause', 'resume', 'stop', 'seek'].includes(command.type)) {
          const action = command.type === 'stop' ? 'pause' : command.type as 'pause' | 'resume' | 'seek'
          void external.action(action, command.type === 'seek' ? command.positionMs : undefined).catch(error => post({ kind: 'event', event: { type: 'error', message: String(error) } }))
          if (command.type === 'pause' || command.type === 'stop') engine.send(JSON.stringify({ type: 'pause' }))
          return
        }
      }
      engine.send(JSON.stringify(message.command))
    } else if (message.kind === 'query') {
      const response = JSON.parse(engine.query(JSON.stringify(message.query)))
      post({ kind: 'queryResult', id: message.id, response })
    } else {
      const cover = readCover(message.path)
      const payload = cover ? { mime: cover.mime, data: new Uint8Array(cover.data) } : null
      post({ kind: 'coverResult', id: message.id, cover: payload })
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    post({ kind: 'event', event: { type: 'error', message: text } })
  }
}

return {
  setVisualizationEnabled: (enabled: boolean) => engine.setVisualizationEnabled(enabled),
  handle: onPortMessage,
  snapshot: (): HostToRenderer[] => [
    ...REPLAYABLE.flatMap(type => latest[type] ? [{ kind: 'event' as const, event: latest[type]! }] : []),
    { kind: 'externalState', state: { ...external!.snapshot(), lyricsText: external!.snapshot().snapshot ? externalLyrics(external!.snapshot().snapshot!) : null } },
    { kind: 'hostReady', active: configured || external!.connected }
  ],
  frame: () => engine.vizFrame(),
  shutdown: () => external!.disconnect(),
}
}
