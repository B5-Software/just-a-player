import { existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../..', import.meta.url))
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
if (!sdk) throw Error('Set ANDROID_HOME to your Android SDK')
const ndk = process.env.ANDROID_NDK_HOME || join(sdk, 'ndk/26.1.10909125')
const host =
  process.platform === 'win32'
    ? 'windows-x86_64'
    : process.platform === 'darwin'
      ? 'darwin-x86_64'
      : 'linux-x86_64'
const bin = join(ndk, 'toolchains/llvm/prebuilt', host, 'bin')
if (!existsSync(bin)) throw Error('Install Android NDK 26.1.10909125')
const targets = [
  ['arm64-v8a', 'aarch64-linux-android', 'aarch64-linux-android'],
  ['armeabi-v7a', 'armv7-linux-androideabi', 'armv7a-linux-androideabi'],
  ['x86', 'i686-linux-android', 'i686-linux-android'],
  ['x86_64', 'x86_64-linux-android', 'x86_64-linux-android'],
]
const lint = process.argv.includes('--clippy')
const wanted = process.argv.slice(2).filter((a) => a !== '--clippy' && a !== '--')
for (const [abi, target, clang] of targets) {
  if (wanted.length && !wanted.includes(abi)) continue
  const env = {
    ...process.env,
    RUSTFLAGS: `${process.env.RUSTFLAGS || ''} -C link-arg=-Wl,-z,max-page-size=16384`,
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4',
  }
  const cc = join(bin, `${clang}28-clang${process.platform === 'win32' ? '.cmd' : ''}`)
  const cxx = join(bin, `${clang}28-clang++${process.platform === 'win32' ? '.cmd' : ''}`)
  env[`CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`] = cc
  env[`CC_${target.replaceAll('-', '_')}`] = cc
  env[`CXX_${target.replaceAll('-', '_')}`] = cxx
  env[`AR_${target.replaceAll('-', '_')}`] = join(
    bin,
    `llvm-ar${process.platform === 'win32' ? '.exe' : ''}`
  )
  env[`CXXFLAGS_${target.replaceAll('-', '_')}`] = '-D_LIBCPP_DISABLE_AVAILABILITY -fPIC'
  console.log(`Building Android ${abi}`)
  const r = spawnSync(
    'cargo',
    [
      lint ? 'clippy' : 'build',
      '--release',
      '-p',
      'jap-android',
      '--target',
      target,
      ...(lint ? ['--', '-D', 'warnings'] : []),
    ],
    { cwd: root, env, stdio: 'inherit' }
  )
  if (r.status !== 0) process.exit(r.status ?? 1)
  if (lint) continue
  const out = join(root, 'apps/android/app/src/main/jniLibs', abi)
  mkdirSync(out, { recursive: true })
  copyFileSync(
    join(root, 'target', target, 'release/libjap_android.so'),
    join(out, 'libjap_android.so')
  )
  const oldRuntime = join(out, 'libc++_shared.so')
  if (existsSync(oldRuntime)) unlinkSync(oldRuntime)
  // DST links libc++ statically so every packaged library supports 16-KiB pages.
}
