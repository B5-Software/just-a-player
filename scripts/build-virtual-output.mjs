import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const folder = join(root, 'apps/desktop/build/virtual-output')
mkdirSync(folder, { recursive: true })
if (process.platform !== 'win32') process.exit(0)
const debug = process.argv.includes('--debug'), target = 'x86_64-pc-windows-msvc'
// This adapter is loaded by the verified x64 NetEase client, including on ARM64 Windows.
for (const [command, args] of [
  ['rustup', ['target', 'add', target]],
  ['cargo', ['build', '-p', 'jap-virtual-output', '--locked', '--target', target, ...(debug ? [] : ['--release'])]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
copyFileSync(join(root, 'target', target, debug ? 'debug' : 'release', 'jap_virtual_output.dll'), join(folder, 'jap_virtual_output.dll'))
writeFileSync(join(folder, 'bundle.json'), JSON.stringify({ arch: 'x64', scope: 'clientProcess', physicalEndpoint: false, name: 'Just A Player HiFi Bridge (Black Hole)' }, null, 2))
