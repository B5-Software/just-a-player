import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'

export function ffmpegPath(): string {
  return process.env['JAP_FFMPEG_PATH'] || 'ffmpeg'
}
/** Resolve outside asar, before either playback or offline utility process starts. */
export function discoverAudioTools(): void {
  process.env['JAP_SOUNDFONT_PATH'] = app.isPackaged
    ? join(process.resourcesPath, 'soundfonts', 'MuseScore_General_HQ.sf2')
    : join(app.getAppPath(), '../../assets/soundfonts/MuseScore_General_HQ.sf2')
  if (process.env['JAP_BUNDLE_MIDI'] === '0')
    process.env['JAP_SOUNDFONT_PATH'] = join(
      app.getPath('userData'),
      'soundfonts/no-bundled-soundfont.sf2'
    )
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
    ...extras.filter(existsSync),
  ]
    .filter((p, i, a) => p && a.indexOf(p) === i)
    .join(delimiter)
}
