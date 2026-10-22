/** 引擎能解码的扩展名，文件选择器与拖放过滤共用这一份。 */
export const AUDIO_EXTENSIONS = [
  'flac',
  'wav',
  'aiff',
  'aif',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'mka',
  'caf',
  'alac',
  'dsf',
  'dff',
  'ncm',
  'ape',
  'dts',
  'dtshd',
  'iso',
  'cue',
  'bin',
  'img',
  'mid',
  'midi',
  'kar',
  'rmi',
] as const

const AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS)

export function isAudioPath(path: string): boolean {
  if (discTrack(path)) return true
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_EXTENSION_SET.has(path.slice(dot + 1).toLowerCase())
}

export function baseName(path: string): string {
  const disc = discTrack(path)
  if (disc) return `${baseName(disc.path)} · 曲目 ${disc.track}`
  return path.split(/[\\/]/).pop() ?? path
}

export function dirName(path: string): string {
  path = discSource(path)
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index < 0 ? '' : path.slice(0, index)
}
/** Windows paths are case insensitive; do not merge distinct POSIX filenames. */
export function pathKey(path: string): string {
  const disc = discTrack(path)
  if (disc) return `disc:${pathKey(disc.path)}:${disc.track}`
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith('/') ? normalized : normalized.toLowerCase()
}

/** Matches the native decoder's stable, UTF-8/base64url subsong identity. */
export function discTrack(path: string): { path: string; track: number } | null {
  const match = /^jap-disc:\/\/([A-Za-z0-9_-]+)\/(\d+)$/.exec(path)
  if (!match || +match[2]! < 1 || +match[2]! > 255) return null
  try {
    const binary = atob(match[1]!.replace(/-/g, '+').replace(/_/g, '/'))
    const source = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0))
    )
    return source.startsWith('jap-disc:') || source.includes('\0')
      ? null
      : { path: source, track: +match[2]! }
  } catch {
    return null
  }
}
export function discSource(path: string): string {
  return discTrack(path)?.path ?? path
}
export function isDiscImage(path: string): boolean {
  return /\.(iso|cue|bin|img)$/i.test(path)
}

/** MIDI instructions and a recording are separate arrangements, not quality duplicates. */
export function isMidiPath(path: string): boolean {
  return /\.(mid|midi|kar|rmi)$/i.test(path)
}
