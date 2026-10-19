import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'

export function ffmpegPath(): string {
  return process.env['JAP_FFMPEG_PATH'] || 'ffmpeg'
}
/** Resolve outside asar, before either playback or offline utility process starts. */
export function discoverAudioTools(): void {
  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'media-tools', 'bin')
    : join(app.getAppPath(), 'build', 'media-tools', 'bin')
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const name of ['ffmpeg', 'ffprobe']) {
    const path = join(bundled, name + suffix)
    if (existsSync(path)) process.env[`JAP_${name.toUpperCase()}_PATH`] = path
  }
  const extras =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin']
      : process.platform === 'linux'
        ? ['/usr/local/bin', '/usr/bin']
        : []
  process.env.PATH = [
    bundled,
    ...(process.env.PATH ?? '').split(delimiter),
    ...extras.filter(existsSync)
  ]
    .filter((p, i, a) => p && a.indexOf(p) === i)
    .join(delimiter)
}
