/** Headless process adapter for the native Rust UI. No BrowserWindow/WebView.
 * Audio frames cross the pipe as bytes and are decoded/output by its Rust engine. */
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { readCover } from '@jap/engine'
import { ExternalPlayer } from './external-player'
import { externalLyrics } from '../renderer/src/external/lyrics'
import type { ExternalAction } from '../shared/external-player'
import type { Event } from '../shared/protocol/Event'
const trace = (value: unknown): void => { if (process.env['JAP_NATIVE_BRIDGE_TRACE'] === '1') console.error(Date.now(), JSON.stringify(value)) }
let pipeOpen = true

function output(message: unknown, data: Uint8Array = new Uint8Array()): void {
  if (!pipeOpen) return
  const json = Buffer.from(JSON.stringify(message))
  if (json.length > 1024 * 1024 || data.length > 8 * 1024 * 1024 || process.stdout.writableLength > 32 * 1024 * 1024)
    throw new Error('原生连接通路超过缓冲预算')
  const header = Buffer.alloc(8)
  header.writeUInt32LE(json.length); header.writeUInt32LE(data.length, 4)
  process.stdout.write(Buffer.concat([header, json, data]))
}
// Keep stdout exclusively for the framed protocol.
console.log = (...values) => console.error(...values)
const engine = {
  send: (command: string): void => {
    const value=JSON.parse(command)
    if (!pipeOpen && value.type === 'stop') { adapter.engineEvent({type:'state',state:'stopped'}); return }
    trace({command:value}); output({ kind: 'command', command:value })
  },
  openLive: (config: string): void => { const value=JSON.parse(config); trace({openLive:{startFrame:value.startFrame,trimStartFrames:value.trimStartFrames,rate:value.track.format.sampleRate}}); output({ kind: 'openLive', config:value }) },
  pushLive: (pts: number, frames: number, data: Buffer): void => output({ kind: 'audio', pts, frames }, data),
  closeLive: (): void => output({ kind: 'closeLive' }),
}
const adapter = new ExternalPlayer(engine,
  process.env['JAP_VIRTUAL_OUTPUT_PATH'] || join(dirname(process.execPath), 'resources', 'virtual-output', 'jap_virtual_output.dll'),
  state => {
    const { cover, ...rest } = state
    output({ kind: 'externalState', state: { ...rest, ...(cover === undefined ? {} : { cover: cover ? { mime: cover.mime } : null }), lyricsText: state.snapshot ? externalLyrics(state.snapshot) : null } }, cover?.data)
  }, readCover)
let stopping = false
let commands: Promise<void> = Promise.resolve()
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (line.length > 1024 * 1024) { void shutdown(); return }
  try {
    const message = JSON.parse(line)
    if (message.kind === 'event') { if(message.event.type==='state')trace({event:message.event}); adapter.engineEvent(message.event as Event); return }
    trace({input:message});
    if (message.kind === 'shutdown') { commands = commands.then(() => shutdown()); return }
    commands = commands.then(async () => {
      if (message.kind === 'localPlay') {
        if (adapter.connected) { await adapter.action('pause'); await adapter.disconnect() }
        engine.send(JSON.stringify(message.command))
      } else if (message.kind === 'action') await adapter.action(message.action as ExternalAction, message.positionMs, message.force === true)
    }).catch(error => output({ kind: 'requestError', message: String(error) }))
  } catch (error) { output({ kind: 'requestError', message: String(error) }) }
})
async function shutdown(parentLost = false): Promise<void> {
  if (parentLost) pipeOpen = false
  if (stopping) { if (parentLost) adapter.engineEvent({type:'state',state:'stopped'}); return }
  stopping = true
  if (parentLost) {
    // The parent's audio device has gone away. Pause the client before restoring
    // its physical output; never leave a crashed native host on a silent sink.
    if (adapter.connected) { try { await adapter.action('pause') } catch {} }
  }
  trace('shutdown started')
  await adapter.disconnect()
  trace({shutdown:adapter.snapshot().phase,message:adapter.snapshot().message})
  output({ kind: 'shutdownDone' })
  input.close()
  process.exit(0)
}
input.on('close', () => { void shutdown(true) })
process.stdout.on('error', () => { void shutdown(true) })
output({ kind: 'ready' })
