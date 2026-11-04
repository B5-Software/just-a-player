/** One headless Rust audio host shared by the full and native interfaces. */
import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { createAudioRuntime } from './audio-runtime'
import { encodeAudioMessage, decodeAudioMessage } from './audio-wire'
import type { HostToRenderer, RendererToHost } from '../shared/ipc'

const endpoint = process.env['JAP_AUDIO_ENDPOINT']
if (!endpoint) throw new Error('Missing audio-service endpoint')
const token = randomUUID()
const clients = new Map<Socket, { viz: boolean }>()
let lastClientAt = Date.now()
let closing = false
const send = (socket: Socket, message: unknown): void => {
  if (!socket.destroyed && socket.writableLength < 16 * 1024 * 1024)
    socket.write(encodeAudioMessage(message))
}
const runtime = createAudioRuntime((message: HostToRenderer) => {
  for (const socket of clients.keys()) send(socket, message)
})
runtime.setVisualizationEnabled(false)
function syncVisualization(): void {
  runtime.setVisualizationEnabled([...clients.values()].some(client => client.viz))
}

async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  await runtime.shutdown().catch(console.error)
  for (const socket of clients.keys()) socket.destroy()
  server.close()
  try {
    if (JSON.parse(readFileSync(endpoint!, 'utf8')).token === token) unlinkSync(endpoint!)
  } catch {}
  process.exit(0)
}

const server = createServer((socket) => {
  let buffer = ''
  const deadline = setTimeout(() => socket.destroy(), 5000)
  socket.setNoDelay(true)
  socket.setEncoding('utf8')
  socket.on('error', () => socket.destroy())
  socket.on('data', (bytes) => {
    buffer += bytes
    if (buffer.length > 24 * 1024 * 1024) { socket.destroy(); return }
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const raw = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        const message = decodeAudioMessage(raw) as Record<string, unknown>
        if (!clients.has(socket)) {
          if (message['token'] !== token || message['kind'] !== 'hello') { socket.destroy(); return }
          clearTimeout(deadline)
          clients.set(socket, { viz: false })
          lastClientAt = Date.now()
          send(socket, { kind: 'ready', pid: process.pid })
          for (const state of runtime.snapshot()) send(socket, state)
        } else if (message['kind'] === 'visibility') {
          clients.get(socket)!.viz = message['visible'] === true
          syncVisualization()
        } else if (message['kind'] === 'shutdown') {
          void shutdown()
        } else if (message['kind'] === 'externalShutdown') {
          void runtime.shutdown().finally(() => send(socket, { kind: 'externalShutdownDone' }))
        } else {
          runtime.handle(message as unknown as RendererToHost, { postMessage: value => send(socket, value) })
        }
      } catch (error) {
        send(socket, { kind: 'event', event: { type: 'error', message: String(error) } })
      }
    }
  })
  socket.on('close', () => {
    clearTimeout(deadline)
    clients.delete(socket)
    syncVisualization()
    lastClientAt = Date.now()
  })
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Audio service failed to bind')
  writeFileSync(endpoint, JSON.stringify({ port: address.port, token, pid: process.pid }), { mode: 0o600 })
})
setInterval(() => {
  if (!clients.size && Date.now() - lastClientAt > 30000) { void shutdown(); return }
  if (![...clients.values()].some(client => client.viz)) return
  const frame = runtime.frame()
  if (frame) for (const [socket, client] of clients) if (client.viz) send(socket, { kind: 'viz', frame })
}, 33)
