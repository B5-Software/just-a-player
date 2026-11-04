import { ui, useLocale } from '../i18n'
import { motion } from 'motion/react'
import { usePlayer } from '../engine/store'
import { FolderOpen, Pause, Play, SkipBack, SkipForward } from '../icons'
import { addAudioPaths } from '../library/actions'
import {
  findNeighbour,
  playDefaultOrResume,
  playNeighbour,
  playPrevious
} from '../library/playback'
import { useLibrary } from '../library/store'
import { useExternal } from '../external/store'

const round = 'grid place-items-center rounded-full transition-colors'

export function Transport({ compact = false }: { compact?: boolean }): React.JSX.Element {
  useLocale()
  const localState = usePlayer((s) => s.state)
  const sourceState = useExternal(s => s.phase === 'routing' || s.snapshot?.devices?.currentDevice.name === 'Just A Player HiFi Bridge (Black Hole)' ? s.snapshot?.state : null)
  const state = sourceState ?? localState
  const hasTrack = usePlayer((s) => s.track !== null)
  const external = useExternal((s) => s.phase === 'routing' || s.snapshot?.devices?.currentDevice.name === 'Just A Player HiFi Bridge (Black Hole)')
  const hasItems = useLibrary((s) => {
    const list = s.lists.find((l) => l.id === s.activeListId) ?? s.lists[0]
    return (list?.items.length ?? 0) > 0
  })
  const canPlay = external || hasTrack || hasItems
  const libraryNext = useLibrary((s) => {
    if (s.playback !== null && findNeighbour(s, s.playback, 1, false) !== null) return true
    const list = s.lists.find((l) => l.id === s.activeListId) ?? s.lists[0]
    return (list?.items.length ?? 0) > 1
  })
  const canNext = external || libraryNext
  const canPrev = external || hasTrack || hasItems

  const openFiles = async (): Promise<void> => {
    const paths = await window.jap.openAudioFiles()
    if (paths.length > 0) await addAudioPaths(paths, true)
  }

  return (
    ui(<div className={`flex items-center justify-center ${compact ? 'gap-1' : 'gap-5'}`}>
      <button
        type="button"
        aria-label="打开文件"
        onClick={() => void openFiles()}
        className={`${round} ${compact ? 'size-8' : 'size-10'} text-fg-muted hover:bg-hover hover:text-fg`}
      >
        <FolderOpen size={20} />
      </button>

      <button
        type="button"
        aria-label="上一首"
        disabled={!canPrev}
        onClick={playPrevious}
        className={`${round} ${compact ? 'size-8' : 'size-11'} text-fg hover:bg-hover disabled:opacity-35`}
      >
        <SkipBack size={22} weight="fill" />
      </button>

      <motion.button
        type="button"
        aria-label={state === 'playing' ? '暂停' : '播放'}
        disabled={!canPlay}
        onClick={playDefaultOrResume}
        whileTap={{ scale: 0.93 }}
        whileHover={{ scale: 1.04 }}
        transition={{ type: 'spring', stiffness: 500, damping: 26 }}
        className={`${round} ${compact ? 'size-9' : 'size-16'} text-on-accent shadow-[0_10px_34px_-6px_rgb(var(--accent)/0.75)] disabled:opacity-40`}
        style={{ background: 'linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-2)))' }}
      >
        {state === 'playing' ? (
          <Pause size={compact ? 18 : 28} weight="fill" />
        ) : (
          <Play size={compact ? 18 : 28} weight="fill" />
        )}
      </motion.button>

      <button
        type="button"
        aria-label="下一首"
        disabled={!canNext}
        onClick={() => {
          if (!playNeighbour(1)) playDefaultOrResume()
        }}
        className={`${round} ${compact ? 'size-8' : 'size-11'} text-fg hover:bg-hover disabled:opacity-35`}
      >
        <SkipForward size={22} weight="fill" />
      </button>

      {!compact && <span className="size-10" aria-hidden />}
    </div>)
  )
}
