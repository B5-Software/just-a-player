// Acquire only at build/development time. Installed apps never download codecs.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, cp, chmod, rename, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const appDir = resolve(fileURLToPath(import.meta.url), '../..')
export const mediaLock = JSON.parse(
  await readFile(join(appDir, 'scripts/media-tools.lock.json'), 'utf8')
)
const cache = join(appDir, 'build/media-cache')
const target = `${process.platform}-${process.arch}`
const destination = join(appDir, 'build/media-tools')

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function downloadAsset(asset) {
  await mkdir(cache, { recursive: true })
  const path = join(cache, asset.name)
  if (
    await sha256(path)
      .then((hash) => hash === asset.sha256)
      .catch(() => false)
  )
    return path
  const url = `https://github.com/${mediaLock.repository}/releases/download/${mediaLock.tag}/${asset.name}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const partial = `${path}.${randomUUID()}.partial`
    try {
      console.log(`Downloading ${asset.name} (SHA-256 pinned)`)
      const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${url}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
      if ((await sha256(partial)) !== asset.sha256)
        throw new Error(`Checksum mismatch: ${asset.name}`)
      await rename(partial, path)
      return path
    } catch (error) {
      await rm(partial, { force: true })
      if (attempt === 2) throw error
    }
  }
}
async function removeGenerated(path) {
  const within = relative(join(appDir, 'build'), resolve(path))
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error('Unsafe generated path')
  await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
async function validate(directory, asset, execute = true) {
  const identity = JSON.parse(await readFile(join(directory, 'bundle.json'), 'utf8'))
  if (identity.target !== target || identity.archiveSha256 !== asset.sha256)
    throw new Error('Stale bundle')
  for (const [path, hash] of Object.entries(identity.files)) {
    const full = resolve(directory, path)
    if (relative(directory, full).startsWith('..') || (await sha256(full)) !== hash)
      throw new Error(`Invalid bundled file: ${path}`)
  }
  if (!execute) return
  for (const name of ['ffmpeg', 'ffprobe']) {
    const executable = join(directory, 'bin', name + (process.platform === 'win32' ? '.exe' : ''))
    const version = execFileSync(executable, ['-version'], { encoding: 'utf8', windowsHide: true })
    if (!version.startsWith(`${name} version ${mediaLock.version} `)) throw new Error(version)
    if (version.includes('--enable-nonfree')) throw new Error('Nonredistributable FFmpeg build')
  }
}
async function prepare() {
  const asset = mediaLock.targets[target]
  if (!asset) throw new Error(`Unsupported media-tools target: ${target}`)
  try {
    await validate(destination, asset)
    console.log(`Verified bundled FFmpeg/ffprobe ${mediaLock.version} for ${target}`)
    return
  } catch {
    /* A fresh download is verified before replacing the generated bundle. */
  }
  const archive = await downloadAsset(asset)
  const staging = join(appDir, `build/.media-tools-${randomUUID()}`)
  const extracted = join(staging, 'extracted')
  const bundle = join(staging, 'bundle')
  await mkdir(extracted, { recursive: true })
  await mkdir(bundle, { recursive: true })
  try {
    execFileSync('tar', ['-xf', archive, '-C', extracted], { windowsHide: true })
    const folders = await readdir(extracted)
    if (folders.length !== 1) throw new Error('Unexpected FFmpeg archive layout')
    const source = join(extracted, folders[0])
    const upstream = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
    if (upstream.av_version_info !== mediaLock.version || upstream.licensing.nonfree)
      throw new Error('Unexpected FFmpeg build identity or license')
    await mkdir(join(bundle, 'bin'))
    for (const name of await readdir(join(source, 'bin')))
      if (/^(ffmpeg|ffprobe)(\.exe)?$|\.dll$/i.test(name))
        await cp(join(source, 'bin', name), join(bundle, 'bin', name))
    const lib = join(source, 'lib')
    if (
      await stat(lib)
        .then(() => true)
        .catch(() => false)
    ) {
      await mkdir(join(bundle, 'lib'))
      for (const name of await readdir(lib))
        if (/\.so(\.|$)|\.dylib(\.|$)/.test(name))
          await cp(join(lib, name), join(bundle, 'lib', name), {
            dereference: false,
            verbatimSymlinks: true
          })
    }
    await cp(join(source, 'licenses'), join(bundle, 'licenses'), { recursive: true })
    await cp(join(source, 'manifest.json'), join(bundle, 'upstream-manifest.json'))
    await cp(
      join(source, 'share/tas-ffmpeg/configure-command.txt'),
      join(bundle, 'configure-command.txt')
    )
    const files = {}
    for (const [path, expected] of Object.entries(upstream.artifacts_sha256)) {
      if (!/^(bin|lib)\//.test(path) || /\.(a|lib)$/.test(path)) continue
      const actual = await sha256(join(bundle, path))
      if (actual !== expected) throw new Error(`Upstream runtime checksum mismatch: ${path}`)
      files[path] = actual
    }
    for (const name of ['ffmpeg', 'ffprobe']) {
      const path = `bin/${name}${process.platform === 'win32' ? '.exe' : ''}`
      if (!files[path]) throw new Error(`Missing verified tool: ${path}`)
      if (process.platform !== 'win32') await chmod(join(bundle, path), 0o755)
    }
    await writeFile(
      join(bundle, 'bundle.json'),
      JSON.stringify(
        {
          target,
          binaryArch: asset.binaryArch,
          version: mediaLock.version,
          archive: asset.name,
          archiveSha256: asset.sha256,
          files
        },
        null,
        2
      ) + '\n'
    )
    const version = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')).version
    await writeFile(
      join(bundle, 'SOURCE.md'),
      `# Bundled FFmpeg ${mediaLock.version}\n\n` +
        `Unmodified upstream runtime: https://github.com/${mediaLock.repository}/releases/tag/${mediaLock.tag}\n` +
        `License: ${mediaLock.license}; full notices are in licenses/.\n` +
        `Complete corresponding source, dependencies and build scripts:\n` +
        `https://github.com/B5-Software/just-a-player/releases/download/v${version}/${mediaLock.source.name}\n` +
        `Upstream mirror: https://github.com/${mediaLock.repository}/releases/download/${mediaLock.tag}/${mediaLock.source.name}\n` +
        `Source SHA-256: ${mediaLock.source.sha256}\n\n` +
        (target === 'win32-arm64'
          ? 'The player is native ARM64; these x64 helper processes use Windows 11 ARM x64 emulation.\n'
          : '')
    )
    // Windows can keep emulated x64 DLLs mapped after the short version process
    // exits. Never execute inside a directory that still needs to be renamed.
    await validate(bundle, asset, false)
    await removeGenerated(destination)
    await rename(bundle, destination)
    await validate(destination, asset)
    console.log(
      `Bundled FFmpeg/ffprobe ${mediaLock.version} for ${target} (${asset.binaryArch} helpers)`
    )
  } finally {
    await removeGenerated(staging)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--source')) {
    const source = await downloadAsset(mediaLock.source)
    const output = resolve(process.argv[process.argv.indexOf('--source') + 1] ?? '.')
    await mkdir(output, { recursive: true })
    await cp(source, join(output, mediaLock.source.name))
    console.log(`Verified corresponding source: ${mediaLock.source.name}`)
  } else await prepare()
}
