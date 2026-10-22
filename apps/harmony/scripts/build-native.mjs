import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../..', import.meta.url))
const sdk =
  process.env.HARMONY_NATIVE_SDK ??
  'C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/native'
const ext = process.platform === 'win32' ? '.exe' : ''
const arch = process.argv.includes('--arm64') ? 'aarch64' : 'x86_64',
  target = arch + '-unknown-linux-ohos',
  triple = arch + '-linux-ohos'
const env = { ...process.env, CC_SHELL_ESCAPED_FLAGS: '1', LIBUDEV_NO_PKG_CONFIG: '1' }
const clang = resolve(sdk, 'llvm/bin/clang' + ext),
  clangxx = resolve(sdk, 'llvm/bin/clang++' + ext),
  ar = resolve(sdk, 'llvm/bin/llvm-ar' + ext)
if (!existsSync(clang)) throw Error('Set HARMONY_NATIVE_SDK to an installed official native SDK')
const sysroot = resolve(sdk, 'sysroot').replaceAll('\\', '/'),
  lib = resolve(sdk, 'llvm/lib', triple).replaceAll('\\', '/')
env['CC_' + target.replaceAll('-', '_')] = clang
env['CXX_' + target.replaceAll('-', '_')] = clangxx
env['AR_' + target.replaceAll('-', '_')] = ar
env['CFLAGS_' + target.replaceAll('-', '_')] =
  `--target=${triple} --sysroot="${sysroot}" -D_UAPI_LINUX_SOCKET_H -D__kernel_sa_family_t=sa_family_t`
env['CXXFLAGS_' + target.replaceAll('-', '_')] =
  `--target=${triple} --sysroot="${sysroot}" -L"${lib}"`
env['CARGO_TARGET_' + target.toUpperCase().replaceAll('-', '_') + '_LINKER'] = clang
env.CARGO_ENCODED_RUSTFLAGS = [
  '-C',
  `link-arg=--target=${triple}`,
  '-C',
  `link-arg=--sysroot=${sysroot}`,
  '-L',
  `native=${lib}`,
].join('\x1f')
const result = spawnSync('cargo', ['build', '-p', 'jap-harmony', '--release', '--target', target], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: false,
})
if (result.status !== 0) process.exit(result.status ?? 1)
const out = resolve(
  root,
  'apps/harmony/entry/src/main/cpp/libs',
  arch === 'aarch64' ? 'arm64-v8a' : 'x86_64'
)
mkdirSync(out, { recursive: true })
copyFileSync(
  resolve(root, 'target', target, 'release/libjap_harmony.a'),
  resolve(out, 'libjap_harmony.a')
)
console.log(`HarmonyOS Rust engine: ${target}`)
