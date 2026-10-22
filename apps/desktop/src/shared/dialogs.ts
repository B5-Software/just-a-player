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
  error?: string
}
