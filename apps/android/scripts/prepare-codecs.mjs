import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('..', import.meta.url)),
  cache = join(root, 'build/codecs'),
  releaseMirror = 'https://github.com/B5-Software/just-a-player/releases/download/v0.1.4'
const sources = [
  {
    name: 'ffmpeg.tar.xz',
    url: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',
    mirror: `${releaseMirror}/android-ffmpeg-9.0.2-source.tar.xz`,
    sha: '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e',
    folder: 'ffmpeg-9.0.2',
  },
  {
    name: 'x264.tar.gz',
    url: 'https://codeload.github.com/mirror/x264/tar.gz/c24e06c2e184345ceb33eb20a15d1024d9fd3497',
    mirror: `${releaseMirror}/android-x264-c24e06c-source.tar.gz`,
    sha: '090d730e867fc63631782a1287974635d1237d0fa7c6fd1d09fd543620a56689',
    folder: 'x264-c24e06c2e184345ceb33eb20a15d1024d9fd3497',
  },
]
function verifySource(source, bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha)
    throw Error(`Source SHA-256 mismatch: ${source.name}`)
  return bytes
}

async function downloadSource(source) {
  const errors = []
  for (const url of [source.url, source.mirror]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw Error(`HTTP ${response.status}`)
      return verifySource(source, Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      errors.push(new Error(`${url}: ${error.message}`, { cause: error }))
    }
  }
  throw new AggregateError(errors, `Source download failed: ${source.name}`)
}

await mkdir(join(cache, 'sources'), { recursive: true })
for (const source of sources) {
  const path = join(cache, source.name)
  if (existsSync(path)) verifySource(source, await readFile(path))
  else await writeFile(path, await downloadSource(source))
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
