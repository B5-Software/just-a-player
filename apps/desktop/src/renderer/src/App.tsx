import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { usePlayer } from './engine/store'
import { Warning, X } from './icons'
import { addAudioPaths } from './library/actions'
import { playDefaultOrResume } from './library/playback'
import { importPlaylists } from './library/io'
import { setLyricsFromFile } from './lyrics/store'
import { LyricsLayer } from './lyrics/LyricsLayer'
import { Dock } from './components/Dock'
import { MiniPlayer } from './components/MiniPlayer'
import { ClockOverlay } from './components/ClockOverlay'
import { PanelHost } from './components/PanelHost'
import { TopBar } from './components/TopBar'
import { Onboarding } from './components/Onboarding'
import { Visualizer } from './components/Visualizer'
import { GraphicsBoundary, StageFallback } from './components/GraphicsBoundary'
import { useUi } from './ui/store'
import { useChromeVisible } from './ui/useChromeVisible'
import { useViz } from './viz/store'

const AUDIO_LIKE = /\.(flac|wav|aiff?|mp3|m4a|aac|ogg|oga|opus|mka|caf|alac)$/i
const LYRICS_LIKE = /\.(lrc|txt)$/i
const PLAYLIST_LIKE = /\.(m3u8?|json)$/i

function ErrorToast(): React.JSX.Element {
  const error = usePlayer((s) => s.error)
  const dismiss = usePlayer((s) => s.dismissError)

  return (
    <AnimatePresence>
      {error && (
        <motion.div
          role="alert"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ type: 'spring', stiffness: 460, damping: 34 }}
          className="glass fixed bottom-48 left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-start gap-3 rounded-2xl px-4 py-3"
        >
          <Warning size={20} weight="fill" className="mt-0.5 shrink-0 text-fidelity-lossy" />
          <p className="select-text text-sm leading-relaxed">{error}</p>
          <button
            type="button"
            aria-label="关闭"
            onClick={dismiss}
            className="grid size-6 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** 全窗口的 3D 舞台，所有控件悬浮在上面；全屏只是窗口级的全屏，布局不变。 */
export function App(): React.JSX.Element {
  const fullscreen = useViz((s) => s.fullscreen)
  const visible = useChromeVisible()
  const [dragging, setDragging] = useState(false)
  const [mode, setMode] = useState<'normal' | 'mini' | 'wallpaper'>('normal')
  useEffect(
    () =>
      window.jap.onWindowMode((value) => {
        setMode(value)
        document.documentElement.dataset['windowMode'] = value
        useUi.getState().closePanel()
        if (value !== 'normal') useUi.getState().setOnboardingOpen(false)
      }),
    []
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target
      if (
        (target instanceof Element && target.closest('input, select, textarea, button')) ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return
      if (mode !== 'normal') {
        if (e.key === 'Escape') void window.jap.setWindowMode('normal')
        else if (e.key === ' ') {
          e.preventDefault()
          playDefaultOrResume()
        }
        return
      }
      const viz = useViz.getState()
      const ui = useUi.getState()
      if (e.key === 'Escape') {
        if (ui.onboardingOpen) ui.setOnboardingOpen(false)
        else if (ui.panel) ui.closePanel()
        else if (viz.fullscreen) viz.setFullscreen(false)
      } else if (e.key === 'f' || e.key === 'F') viz.setFullscreen(!viz.fullscreen)
      else if (e.key === 'n' || e.key === 'N') viz.step(1)
      else if (e.key === 'p' || e.key === 'P') viz.step(-1)
      else if (e.key === ' ') {
        e.preventDefault()
        playDefaultOrResume()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => window.jap.pathForFile(f)).filter(Boolean)
    if (paths.length === 0) return

    const lyrics = paths.filter((p) => LYRICS_LIKE.test(p))
    const playlists = paths.filter((p) => PLAYLIST_LIKE.test(p))
    const audio = paths.filter((p) => !LYRICS_LIKE.test(p) && !PLAYLIST_LIKE.test(p))

    if (playlists.length) void importPlaylists(playlists)
    const track = usePlayer.getState().track
    // A directory/audio import reads sidecars per winning audio path. An LRC
    // explicitly dropped alone is the only operation that overrides this track.
    if (lyrics.length && track && audio.length === 0)
      await setLyricsFromFile(track.path, lyrics[0]!)
    if (audio.length) await addAudioPaths(audio, true)
  }

  return (
    <div
      data-player-app
      className={`relative h-full w-full overflow-hidden bg-[#07070b] ${fullscreen && !visible ? 'cursor-none' : ''}`}
      onDragOver={(e) => {
        // 只有外部文件拖入才显示提示；列表内部的拖拽排序不触发
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div data-player-stage className="absolute inset-0">
        <GraphicsBoundary fallback={(retry) => <StageFallback retry={retry} />}>
          <Visualizer />
          <LyricsLayer />
        </GraphicsBoundary>
      </div>
      {fullscreen && mode === 'normal' && <ClockOverlay />}
      {mode === 'mini' && <MiniPlayer />}
      {mode === 'normal' && (
        <>
          <TopBar visible={visible} />
          <Dock visible={visible} />
          <PanelHost />
          <Onboarding />
        </>
      )}

      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-4 z-40 grid place-items-center rounded-[36px] border-2 border-dashed border-accent bg-accent/10 backdrop-blur-sm"
          >
            <span className="font-display text-2xl font-semibold text-accent-text">
              松手即可播放
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <ErrorToast />
    </div>
  )
}
