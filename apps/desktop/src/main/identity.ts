import { app, shell, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { icon } from './desktop-icon'
const APP_ID = 'B5Software.JustAPlayer'
export function registerIdentity(win: BrowserWindow): void {
  win.setIcon(icon())
  if (process.platform !== 'win32') return
  const dir = join(app.getPath('userData'), 'identity')
  mkdirSync(dir, { recursive: true })
  const png = icon().resize({ width: 256, height: 256 }).toPNG(),
    image = join(dir, 'app.png'),
    ico = join(dir, 'app.ico')
  writeFileSync(image, png)
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  writeFileSync(ico, Buffer.concat([header, png]))
  const args = app.isPackaged ? '' : `"${app.getAppPath()}"`
  win.setAppDetails({
    appId: APP_ID,
    appIconPath: ico,
    appIconIndex: 0,
    relaunchCommand: `"${process.execPath}" ${args}`,
    relaunchDisplayName: 'Just A Player'
  })
  if (process.env['JAP_E2E']) return
  try {
    const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`
    for (const [name, value] of [
      ['DisplayName', 'Just A Player'],
      ['IconUri', image]
    ])
      execFileSync(
        'reg.exe',
        ['add', key, '/v', name!, '/t', 'REG_EXPAND_SZ', '/d', value!, '/f'],
        { windowsHide: true, stdio: 'ignore' }
      )
    const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    mkdirSync(programs, { recursive: true })
    shell.writeShortcutLink(join(programs, 'Just A Player.lnk'), {
      target: process.execPath,
      args,
      cwd: app.getAppPath(),
      appUserModelId: APP_ID,
      description: 'Just A Player',
      icon: ico,
      iconIndex: 0
    })
  } catch (error) {
    console.error('[identity] 无法注册应用显示名称', error)
  }
}
