export interface FileDialogRequest {
  id: string
  title: string
  mode: 'open' | 'folder' | 'save'
  multiple: boolean
  extensions: string[]
  defaultPath?: string
}
export interface BrowserEntry {
  name: string
  path: string
  directory: boolean
  size: number
}
export interface BrowserListing {
  path: string
  parent: string | null
  roots: { name: string; path: string }[]
  entries: BrowserEntry[]
  virtual?: boolean
  selectedPath?: string
  musicPermissionNeeded?: boolean
  error?: string
}

export const WINDOWS_COMPUTER = 'jap://computer'

export function matchesFileType(name: string, extensions: readonly string[]): boolean {
  const dot = name.lastIndexOf('.')
  return !extensions.length || extensions.includes('*') ||
    (dot >= 0 && extensions.includes(name.slice(dot + 1).toLowerCase()))
}

export function validSaveName(name: string, windows: boolean): boolean {
  if (!name || name === '.' || name === '..' || /[\/\x00-\x1f]/.test(name)) return false
  return !windows || (!/[\\<>:"|?*]|[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(name))
}
