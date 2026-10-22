import { useSettings } from '../settings/store'
import { useLibrary } from './store'
import { addAudioPaths } from './actions'
let scanning = false
export async function scanMusicFolders(): Promise<number> {
  if (scanning) return 0
  scanning = true
  try {
    const configured = useSettings.getState().musicFolders
    const dirs = configured.length ? configured : await window.jap.musicFolders()
    if (!dirs.length) return 0
    const library = useLibrary.getState()
    let target = library.lists.find((l) => l.name === '本地音乐')?.id
    if (!target) {
      const previous = library.activeListId
      target = library.createList('本地音乐')
      useLibrary.getState().setActive(previous)
    }
    return await addAudioPaths(dirs, false, target, true)
  } finally {
    scanning = false
  }
}
export function initScanner(): void {
  const scan = (): void => {
    if (useSettings.getState().autoScan && useLibrary.getState().loaded) void scanMusicFolders()
  }
  // Rescan in the background; async filesystem traversal does not block main/UI.
  window.setInterval(scan, 60000)
  useLibrary.subscribe((s, p) => {
    if (s.loaded && !p.loaded) scan()
  })
  useSettings.subscribe((s, p) => {
    if ((s.autoScan && !p.autoScan) || s.musicFolders !== p.musicFolders) scan()
  })
}
