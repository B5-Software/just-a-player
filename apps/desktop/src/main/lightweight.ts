import { app } from 'electron'
import { spawn } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { LightweightHandoff } from '../shared/lightweight'
import { isAudioPath } from '../shared/audio'

let opening = false
const path = (name: string): string => join(app.getPath('userData'), name)
export function wantsLightweight(): boolean {
  if (process.argv.includes('--jap-full') || process.env['JAP_E2E']) return false
  try {
    return JSON.parse(readFileSync(path('lightweight-mode.json'), 'utf8')).enabled === true
  } catch {
    return false
  }
}
export function takeLightweightHandoff(): LightweightHandoff | null {
  try {
    const file = path('light-return.json'),
      value = JSON.parse(readFileSync(file, 'utf8'))
    unlinkSync(file)
    return value
  } catch {
    return null
  }
}
export async function openLightweight(
  handoff?: LightweightHandoff,
  releaseEngine?: () => void
): Promise<void> {
  if (opening) return
  opening = true
  try {
    const exe = process.platform === 'win32' ? 'jap-lightweight.exe' : 'jap-lightweight'
    const root = resolve(__dirname, '../../../..')
    const binary = app.isPackaged
      ? join(process.resourcesPath, 'lightweight', exe)
      : join(root, 'target/debug', exe)
    if (!existsSync(binary)) throw new Error('未找到轻量播放程序，请先运行 pnpm light:build。')
    releaseEngine?.()
    mkdirSync(app.getPath('userData'), { recursive: true })
    const ready = path(`light-ready-${process.pid}`)
    if (existsSync(ready)) unlinkSync(ready)
    const appImage = process.platform === 'linux' ? process.env['APPIMAGE'] : undefined
    const args = [
      '--data-dir',
      app.getPath('userData'),
      '--resources',
      app.isPackaged ? process.resourcesPath : join(root, 'apps/desktop/build'),
      '--return-app',
      appImage || process.execPath,
    ]
    if (!appImage) args.push('--ready-file', ready)
    if (!app.isPackaged) args.push('--return-entry', join(__dirname, 'index.js'))
    if (process.env['JAP_E2E'] === 'lightweight') args.push('--qa')
    if (handoff) {
      const file = path('light-start.json')
      writeFileSync(file, JSON.stringify(handoff))
      args.push('--handoff', file)
    }
    const files = process.argv.filter(value => isAudioPath(value) && existsSync(value))
    if (files.length) args.push('--', ...files)
    if (appImage) {
      // Keep the AppImage mount owned by the same PID while replacing Electron.
      // Returning launches the original AppImage, which obtains its own mount.
      if (!process.execve)
        throw new Error('此运行环境不支持 AppImage 轻量接管，请使用 DEB 安装包。')
      writeFileSync(path('lightweight-mode.json'), '{"enabled":true}')
      try {
        process.execve(binary, [binary, ...args])
      } catch (error) {
        writeFileSync(path('lightweight-mode.json'), '{"enabled":false}')
        throw error
      }
      return
    }
    const log = openSync(path('lightweight-host.log'), 'a')
    let child
    try {
      child = spawn(binary, args, {
        detached: true,
        stdio: ['ignore', log, log],
        windowsHide: true,
      })
    } finally {
      closeSync(log)
    }
    await new Promise<void>((accept, reject) => {
      const start = Date.now()
      const timer = setInterval(() => {
        if (existsSync(ready)) {
          clearInterval(timer)
          unlinkSync(ready)
          accept()
        } else if (child.exitCode !== null || Date.now() - start > 30000) {
          clearInterval(timer)
          child.kill()
          reject(new Error('轻量模式未能启动，请检查原生窗口与显卡驱动。'))
        }
      }, 100)
      child.once('error', (error) => {
        clearInterval(timer)
        reject(error)
      })
    })
    writeFileSync(path('lightweight-mode.json'), '{"enabled":true}')
    child.unref()
    setTimeout(() => app.quit(), 150)
  } finally {
    opening = false
  }
}
