import { app } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { connect } from 'node:net'
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs'

async function available(path: string): Promise<boolean> {
  let endpoint: {port:number;token:string;pid:number}
  try {
    endpoint = JSON.parse(readFileSync(path, 'utf8'))
    if (!Number.isInteger(endpoint.port) || !Number.isInteger(endpoint.pid) || typeof endpoint.token !== 'string') return false
    process.kill(endpoint.pid, 0)
  } catch { return false }
  return new Promise(resolve => {
    const socket = connect({host:'127.0.0.1',port:endpoint.port})
    let complete = false
    const finish = (value: boolean): void => { if (complete) return; complete=true;clearTimeout(timer);socket.destroy();resolve(value) }
    const timer = setTimeout(() => finish(false),1000)
    socket.on('connect',()=>socket.write(JSON.stringify({kind:'hello',token:endpoint.token})+'\n'))
    socket.on('data',bytes=>{if(bytes.toString().includes('"kind":"ready"'))finish(true)})
    socket.on('error',()=>finish(false))
    socket.on('close',()=>finish(false))
  })
}

export async function ensureAudioService(): Promise<void> {
  const root = app.getPath('userData')
  mkdirSync(root, { recursive: true })
  const endpoint = join(root, 'audio-service.json')
  process.env['JAP_AUDIO_ENDPOINT'] = endpoint
  if (await available(endpoint)) return
  const log = openSync(join(root, 'audio-service.log'), 'a')
  let child
  try {
    let binary = process.execPath, entry = join(__dirname, 'audio-service.js')
    if (app.isPackaged && process.platform === 'linux' && process.env['APPIMAGE']) {
      binary = process.env['APPIMAGE']
      entry = join(root, 'audio-bootstrap.cjs')
      writeFileSync(entry, "const p=require('node:path'),r=p.join(p.dirname(process.execPath),'resources'),old=process.env.JAP_PARENT_RESOURCES;for(const k of ['JAP_FFMPEG_PATH','JAP_FFPROBE_PATH','JAP_SOUNDFONT_PATH','JAP_VIRTUAL_OUTPUT_PATH']){const v=process.env[k];if(old&&v?.startsWith(old+'/'))process.env[k]=p.join(r,p.relative(old,v));}require(p.join(r,'app.asar','out','main','audio-service.js'));\n")
    }
    child = spawn(binary, [entry, '--data-dir', root], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', JAP_PARENT_RESOURCES: process.resourcesPath },
    })
  } finally { closeSync(log) }
  child.unref()
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await available(endpoint)) return
    if (child.exitCode !== null && child.exitCode !== 0) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Audio service failed to start')
}
