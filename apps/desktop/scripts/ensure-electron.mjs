import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('electron/package.json'))
const executable =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron'
if (!existsSync(join(root, 'path.txt')) || !existsSync(join(root, 'dist', executable))) {
  console.log('Preparing Electron runtime…')
  const result = spawnSync(process.execPath, [join(root, 'install.js')], {
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (!existsSync(join(root, 'dist', executable)))
  throw new Error('Electron runtime is missing; run pnpm install and retry.')
