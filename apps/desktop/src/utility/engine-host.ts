/** MessagePort relay. Playback stays in the shared headless Rust audio host. */
import { connect, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import type { HostToRenderer, RendererToHost } from '../shared/ipc'
import { createAudioRuntime } from './audio-runtime'
import { encodeAudioMessage, decodeAudioMessage } from './audio-wire'

const parentPort = process.parentPort
const ports = new Map<string, Electron.MessagePortMain>()
const latest = new Map<string, HostToRenderer>()
let vizActive = true
let vizSurface = 'main'
let socket: Socket | null = null
let ready = false
const backlog: unknown[] = []
const endpoint = process.env['JAP_AUDIO_ENDPOINT']
const post = (message: HostToRenderer): void => {
  if (message.kind === 'viz') {
    ports.get(vizSurface)?.postMessage(message)
    return
  }
  if (message.kind === 'event' && !['error','queueEnded','bufferReset','qualityError'].includes(message.event.type))
    latest.set(message.event.type, message)
  if (message.kind === 'externalState') {
    const previous = latest.get('externalState')
    const old = previous?.kind === 'externalState' ? previous.state : undefined
    latest.set('externalState', { ...message, state: {
      ...message.state,
      cover: message.state.cover === undefined ? old?.cover : message.state.cover,
      snapshot: message.state.snapshot ? {...message.state.snapshot,queue:message.state.snapshot.queue ?? old?.snapshot?.queue} : null,
    } })
  }
  if (message.kind === 'hostReady') latest.set('hostReady', message)
  for (const port of ports.values()) port.postMessage(message)
}
const local = endpoint ? null : createAudioRuntime(post)
function send(message: unknown): void {
  if (socket && ready) socket.write(encodeAudioMessage(message))
  else backlog.push(message)
}
if (endpoint) {
  const config = JSON.parse(readFileSync(endpoint, 'utf8'))
  socket = connect({ host: '127.0.0.1', port: config.port })
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('connect', () => socket!.write(encodeAudioMessage({ kind: 'hello', token: config.token })))
  socket.on('data', bytes => {
    buffer += bytes
    if (buffer.length > 24 * 1024 * 1024) { socket!.destroy(); return }
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try {
        const message = decodeAudioMessage(raw) as HostToRenderer | { kind: 'ready' } | { kind: 'externalShutdownDone' }
        if (message.kind === 'ready') {
          ready = true
          for (const item of backlog.splice(0)) send(item)
          send({ kind: 'visibility', visible: vizActive })
        } else if (message.kind === 'externalShutdownDone')
          parentPort.postMessage({ type: 'externalShutdownDone' })
        else post(message)
      } catch (error) { console.error(error) }
    }
  })
  socket.on('error', error => post({ kind: 'event', event: { type: 'error', message: String(error) } }))
}
function attach(port: Electron.MessagePortMain, surface: string): void {
  ports.get(surface)?.close()
  ports.set(surface, port)
  port.on('message', event => {
    const message = event.data as RendererToHost
    if (local) local.handle(message, port)
    else send(message)
  })
  port.on('close', () => { if (ports.get(surface) === port) ports.delete(surface) })
  port.start()
  if (local) for (const message of local.snapshot()) port.postMessage(message)
  else {
    for (const message of latest.values()) if (message.kind !== 'hostReady') port.postMessage(message)
    const ready = latest.get('hostReady')
    if (ready) port.postMessage(ready)
  }
}
parentPort.on('message', event => {
  const data = event.data as { type?: string; visible?: boolean; surface?: string }
  const [port] = event.ports
  if (data.type === 'attach' && port) attach(port, data.surface ?? 'main')
  if (data.type === 'visibility') {
    vizActive = data.visible !== false
    vizSurface = data.surface ?? 'main'
    if (socket) send({ kind: 'visibility', visible: vizActive })
    local?.setVisualizationEnabled(vizActive)
  }
  if (data.type === 'externalShutdown') {
    if (local) void local.shutdown().finally(() => parentPort.postMessage({ type: 'externalShutdownDone' }))
    else send({ kind: 'externalShutdown' })
  }
  if (data.type === 'audioShutdown') send({ kind: 'shutdown' })
  if (data.type === 'detach') {
    for (const port of ports.values()) port.close()
    ports.clear()
    socket?.destroy()
    parentPort.postMessage({ type: 'detached' })
    setTimeout(() => process.exit(0), 25)
  }
})
if (local) setInterval(() => {
  if (!ports.size || !vizActive) return
  const frame = local.frame()
  if (frame) ports.get(vizSurface)?.postMessage({ kind: 'viz', frame })
}, 16)
