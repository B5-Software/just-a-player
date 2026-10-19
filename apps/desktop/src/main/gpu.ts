import { app, ipcMain } from 'electron'
import * as native from '@jap/engine'
import { getSettings } from './settings'
import { IPC } from '../shared/ipc'
import type { GpuAdapter, GpuInfo } from '../shared/gpu'
let adapters: GpuAdapter[] = [],
  error: string | null = null
let selected = 'auto'
/** Run before Electron initializes its GPU process. */
export function selectGpu(): void {
  try {
    adapters = (native as unknown as { gpuAdapters(): GpuAdapter[] }).gpuAdapters()
  } catch (e) {
    error = String(e)
  }
  const choice = adapters.find((g) => g.id === getSettings().renderGpu)
  if (choice) {
    selected = choice.id
    app.commandLine.appendSwitch('use-angle', 'd3d11')
    app.commandLine.appendSwitch('use-adapter-luid', choice.luid)
  }
}
export function registerGpu(trusted: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(IPC.gpuInfo, async (event): Promise<GpuInfo | null> => {
    if (!trusted(event)) return null
    const info = (await app.getGPUInfo('complete')) as { auxAttributes?: { glRenderer?: string } }
    return { adapters, selected, current: info.auxAttributes?.glRenderer ?? '系统默认', error }
  })
  ipcMain.handle(IPC.restart, (event) => {
    if (trusted(event)) {
      app.relaunch()
      app.quit()
    }
  })
}
