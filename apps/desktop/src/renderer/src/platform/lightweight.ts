import { usePlayer } from '../engine/store'
import { useDsp } from '../audio/dsp-store'
import { livePositionMs } from '../engine/clock'
import { persistLibraryNow } from '../library'
import { useLibrary, type SavedLibrary } from '../library/store'
import { engine } from '../engine/client'
import { onTrackChanged } from '../library/playback'
import { useTheme } from '../theme/store'
import { useSettings } from '../settings/store'
import { useCover } from '../cover/store'
let handoffReady: Promise<unknown> = Promise.resolve()
async function libraryReady(): Promise<void> {
  if (useLibrary.getState().loaded) return
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      off()
      reject(new Error('曲库尚未完成读取，请稍后再切换轻量模式。'))
    }, 15000)
    const off = useLibrary.subscribe((s) => {
      if (s.loaded) {
        window.clearTimeout(timer)
        off()
        resolve()
      }
    })
  })
}

export async function enterLightweight(): Promise<void> {
  await handoffReady
  await libraryReady()
  useLibrary.getState().rememberPosition(livePositionMs())
  const libraryJson = await persistLibraryNow()
  const player = usePlayer.getState()
  const { themeMode, accent, autoAccent } = useSettings.getState()
  const cover = useCover.getState()
  await window.jap.openLightweight({
    libraryJson,
    track: player.track,
    state: player.state,
    positionMs: livePositionMs(),
    volume: player.volume,
    output: player.output,
    dsp: useDsp.getState().config,
    externalForce: localStorage.getItem('jap.external.force') === '1',
    appearance: {
      themeMode,
      accent,
      autoAccent,
      resolved: useTheme.getState().resolved,
      activeAccent: autoAccent && cover.path === player.track?.path ? cover.palette?.primary : undefined,
    },
  })
}
export function initLightweightHandoff(): void {
  handoffReady = window.jap
    .takeLightweightHandoff()
    .then(async (handoff) => {
      if (!handoff) return
      await libraryReady()
      if (handoff.libraryJson)
        useLibrary.getState().hydrate(JSON.parse(handoff.libraryJson) as SavedLibrary)
      if (handoff.sharedAudio) {
        usePlayer.setState({ volume: handoff.volume, output: handoff.output })
        useDsp.setState({ config: handoff.dsp })
        const track = usePlayer.getState().track
        if (track) onTrackChanged(track)
        return
      }
      usePlayer.getState().setVolume(handoff.volume)
      usePlayer.getState().setOutput(handoff.output)
      useDsp.getState().update(handoff.dsp)
      if (handoff.track) {
        if (handoff.track.path.startsWith('external://')) {
          usePlayer.setState({ track: handoff.track, state: 'paused', position: { ms: handoff.positionMs, at: performance.now() } })
          await engine.external('connect', undefined, handoff.externalForce === true)
          await engine.external('route')
          if (handoff.state === 'playing') await engine.external('resume')
          return
        }
        const library = useLibrary.getState()
        const contains = (list: (typeof library.lists)[number]): boolean =>
          list.items.some((item) => item.path === handoff.track!.path)
        const list =
          library.lists.find((list) => list.id === library.activeListId && contains(list)) ??
          library.lists.find(contains)
        if (list) {
          const ids = list.items.map((item) => item.id)
          const remembered = library.memories[list.id]?.order ?? []
          const order = library.shuffle
            ? [
                ...remembered.filter((id) => ids.includes(id)),
                ...ids.filter((id) => !remembered.includes(id)),
              ]
            : ids
          const item = list.items.find((item) => item.path === handoff.track!.path)!
          library.setPlayback({ listId: list.id, order, index: order.indexOf(item.id) })
        }
        if (
          window.jap.platform !== 'android' &&
          window.jap.platform !== 'ohos' &&
          handoff.state === 'playing'
        ) {
          engine.send({
            type: 'play',
            path: handoff.track.path,
            startMs: handoff.positionMs,
          })
        } else
          usePlayer.setState({
            track: handoff.track,
            ...(window.jap.platform === 'android' || window.jap.platform === 'ohos'
              ? { state: handoff.state }
              : {}),
            position: { ms: handoff.positionMs, at: performance.now() },
          })
        onTrackChanged(handoff.track)
      }
    })
    .catch((error) => usePlayer.setState({ error: String(error) }))
}
