import { addAudioPaths } from './actions'
import { useLibrary, makeList } from './store'
import { playItem } from './playback'
import { usePlayer } from '../engine/store'
import { pathKey, isAudioPath, discSource, isDiscImage } from '@shared/audio'
import { importPlaylists } from './io'
import { engine } from '../engine/client'
const OPEN_LIST = 'jap-external-files'
let running = false
let requested = false
async function open(paths: string[]): Promise<void> {
  const audio = paths.filter(isAudioPath)
  const playlists = paths.filter((p) => /\.(m3u|m3u8)$/i.test(p))
  for (const path of playlists) {
    if (await importPlaylists([path])) {
      const id = useLibrary.getState().activeListId
      const list = useLibrary.getState().lists.find((l) => l.id === id)
      const first = list?.items.find((i) => !i.missing)
      if (first) playItem(id, first.id)
    }
  }
  if (!audio.length) return
  const state = useLibrary.getState()
  if (!state.lists.some((l) => l.id === OPEN_LIST)) {
    useLibrary.setState({ lists: [...state.lists, { ...makeList('外部打开'), id: OPEN_LIST }] })
  }
  useLibrary.getState().setActive(OPEN_LIST)
  await addAudioPaths(audio, false, OPEN_LIST)
  let firstPath = audio[0]!
  if (isDiscImage(firstPath)) {
    const result = await engine.query({ type: 'discTracks', path: firstPath })
    if (result.type === 'tracks' && result.tracks[0]) firstPath = result.tracks[0].path
  }
  const list = useLibrary.getState().lists.find((l) => l.id === OPEN_LIST)
  const first =
    list?.items.find(
      (i) =>
        pathKey(i.path) === pathKey(firstPath) || pathKey(discSource(i.path)) === pathKey(firstPath)
    ) ?? list?.items.find((i) => audio.some((p) => pathKey(p) === pathKey(i.path)))
  if (first) playItem(OPEN_LIST, first.id)
}
/** Drain only after hydration and engine setup; cold launches cannot lose documents. */
export function initFileOpening(): void {
  const drain = async (): Promise<void> => {
    requested = true
    if (running || !useLibrary.getState().loaded || !usePlayer.getState().connected) return
    running = true
    try {
      while (requested) {
        requested = false
        const paths = await window.jap.takeOpenFiles()
        if (paths.length) await open(paths)
      }
    } catch (error) {
      usePlayer.setState({ error: `无法打开音乐文件：${String(error)}` })
    } finally {
      running = false
    }
  }
  window.jap.onOpenFiles(() => {
    void drain()
  })
  useLibrary.subscribe((s, p) => {
    if (s.loaded && !p.loaded) void drain()
  })
  usePlayer.subscribe((s, p) => {
    if (s.connected && !p.connected) void drain()
  })
  void drain()
}
