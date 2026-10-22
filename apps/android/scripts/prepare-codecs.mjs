import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('..', import.meta.url)),
  cache = join(root, 'build/codecs')
const sources = [
  {
    name: 'ffmpeg.tar.xz',
    url: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',
    sha: '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e',
    folder: 'ffmpeg-9.0.2',
  },
  {
    name: 'x264.tar.gz',
    url: 'https://codeload.github.com/mirror/x264/tar.gz/c24e06c2e184345ceb33eb20a15d1024d9fd3497',
    sha: '090d730e867fc63631782a1287974635d1237d0fa7c6fd1d09fd543620a56689',
    folder: 'x264-c24e06c2e184345ceb33eb20a15d1024d9fd3497',
  },
]
await mkdir(join(cache, 'sources'), { recursive: true })
for (const source of sources) {
  const path = join(cache, source.name)
  if (!existsSync(path)) {
    const r = await fetch(source.url)
    if (!r.ok) throw Error(`Source download: ${r.status}`)
    await writeFile(path, Buffer.from(await r.arrayBuffer()))
  }
  if (
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex') !== source.sha
  )
    throw Error(`Source SHA-256 mismatch: ${source.name}`)
  if (!existsSync(join(cache, 'sources', source.folder))) {
    const r = spawnSync('tar', ['-xf', path, '-C', join(cache, 'sources')], {
      stdio: 'inherit',
    })
    if (r.status !== 0) throw Error('Source extraction failed')
  }
}
const notices = join(root, 'app/src/main/assets/licenses')
await mkdir(notices, { recursive: true })
await writeFile(join(notices, 'android-ffmpeg-sources.json'), JSON.stringify(sources, null, 2))
await copyFile(
  join(cache, 'sources/ffmpeg-9.0.2/COPYING.GPLv2'),
  join(notices, 'FFmpeg-GPL-2.0.txt')
)
await copyFile(
  join(cache, 'sources/x264-c24e06c2e184345ceb33eb20a15d1024d9fd3497/COPYING'),
  join(notices, 'x264-GPL-2.0.txt')
)
await copyFile(join(root, '../../LICENSE'), join(notices, 'Just-A-Player-GPL-3.0.txt'))
const args = process.argv.slice(2),
  abis = args.length ? args : ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const r = spawnSync(bash, ['scripts/build-codecs.sh', ...abis], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
process.exit(r.status ?? 1)
