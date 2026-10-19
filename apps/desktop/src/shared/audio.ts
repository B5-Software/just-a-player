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
  'cue'
] as const

const AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS)

export function isAudioPath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_EXTENSION_SET.has(path.slice(dot + 1).toLowerCase())
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index < 0 ? '' : path.slice(0, index)
}
/** Windows paths are case insensitive; do not merge distinct POSIX filenames. */
export function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith('/') ? normalized : normalized.toLowerCase()
}
