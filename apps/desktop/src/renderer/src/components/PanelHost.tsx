import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { X } from '../icons'
import { useUi, type PanelId } from '../ui/store'
import { AppearancePanel } from './AppearancePanel'
import { LyricsPanel } from './LyricsPanel'
import { OutputPanel } from './OutputPanel'
import { PlaylistPanel } from './PlaylistPanel'
import { SettingsPanel } from './SettingsPanel'
import { SignalPathPanel } from './SignalPathPanel'
import { DspPanel } from './DspPanel'
import { QualityPanel } from './QualityPanel'
import { VideoPanel } from './VideoPanel'
import { VideoQueuePanel } from './VideoQueuePanel'

const TITLES: Record<PanelId, string> = {
  exports: '导出队列',
  video: '导出视频',
  dsp: 'DSP / EQ',
  quality: '音源分析',
  signal: '信号链',
  output: '输出',
  playlist: '播放列表',
  lyrics: '歌词',
  appearance: '外观',
  settings: '设置'
}

const WIDTHS: Record<PanelId, number> = {
  exports: 440,
  video: 420,
  dsp: 520,
  quality: 440,
  signal: 380,
  output: 340,
  playlist: 680,
  lyrics: 360,
  appearance: 360,
  settings: 360
}

/** 面板的宽度与位置；播放列表停在控制坞上方。 */
const SIZES: Record<PanelId, string> = {
  exports: 'w-[440px] max-h-[75vh]',
  video: 'w-[420px] max-h-[75vh]',
  dsp: 'w-[520px] max-h-[75vh]',
  quality: 'w-[440px] max-h-[75vh]',
  signal: 'w-[380px] max-h-[65vh]',
  output: 'w-[340px] max-h-[65vh]',
  playlist: 'w-[680px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-14.5rem)]',
  lyrics: 'w-[360px] max-h-[65vh]',
  appearance: 'w-[360px] max-h-[65vh]',
  settings: 'w-[360px] max-h-[65vh]'
}

const CONTENT: Record<PanelId, React.JSX.Element> = {
  exports: <VideoQueuePanel />,
  video: <VideoPanel />,
  dsp: <DspPanel />,
  quality: <QualityPanel />,
  signal: <SignalPathPanel />,
  output: <OutputPanel />,
  playlist: <PlaylistPanel />,
  lyrics: <LyricsPanel />,
  appearance: <AppearancePanel />,
  settings: <SettingsPanel />
}

/** 同一时间只显示一个面板；点击面板外或按 Esc 收起。尽可能让面板中心与触发按钮对齐。 */
export function PanelHost(): React.JSX.Element {
  const panel = useUi((s) => s.panel)
  const close = useUi((s) => s.closePanel)
  const [layout, setLayout] = useState<{ left: number; top: number; originX: number }>({
    left: 24,
    top: 76,
    originX: 50
  })

  useEffect(() => {
    if (!panel) return

    const updateLayout = (): void => {
      const btn = document.querySelector(`[data-toolbar-id="${panel}"]`)
      const targetWidth = WIDTHS[panel] ?? 360
      const margin = 16
      const windowWidth = window.innerWidth

      if (btn) {
        const rect = btn.getBoundingClientRect()
        const btnCenterX = rect.left + rect.width / 2
        // 尽可能让面板水平中心与选定的按钮垂直中线居中对齐
        const idealLeft = btnCenterX - targetWidth / 2
        // 边上的另当别论：如果贴近边缘，限制在安全边界内
        const minLeft = margin
        const maxLeft = Math.max(margin, windowWidth - targetWidth - margin)
        const clampedLeft = Math.max(minLeft, Math.min(maxLeft, idealLeft))
        const originX = Math.max(5, Math.min(95, ((btnCenterX - clampedLeft) / targetWidth) * 100))

        setLayout({
          left: Math.round(clampedLeft),
          top: Math.max(76, Math.round(rect.bottom + 18)),
          originX: Math.round(originX)
        })
      } else {
        const defaultLeft = Math.max(margin, windowWidth - targetWidth - margin)
        setLayout({ left: defaultLeft, top: 76, originX: 90 })
      }
    }

    updateLayout()
    window.addEventListener('resize', updateLayout)
    return () => window.removeEventListener('resize', updateLayout)
  }, [panel])

  useEffect(() => {
    if (!panel) return
    const onDown = (e: PointerEvent): void => {
      if (useUi.getState().lyricsAdjusting) return
      // Exiting and entering Motion panels coexist. A shared ref can point to the
      // exiting panel or be cleared by its unmount; inspect the event path instead.
      if (
        e
          .composedPath()
          .some(
            (node) =>
              node instanceof Element &&
              node.matches('[data-panel-root], [data-toolbar], [data-panel-portal]')
          )
      )
        return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [panel, close])

  return (
    <AnimatePresence>
      {panel && (
        <motion.div
          key={panel}
          data-panel-root={panel}
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 500, damping: 36 }}
          style={{
            left: `${layout.left}px`,
            top: `${layout.top}px`,
            transformOrigin: `${layout.originX}% 0px`
          }}
          className={`glass panel-surface fixed z-30 flex flex-col gap-4 overflow-hidden rounded-3xl p-5 ${SIZES[panel]}`}
        >
          <header className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold">{TITLES[panel]}</h2>
            <button
              type="button"
              aria-label="关闭"
              onClick={close}
              className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
            >
              <X size={14} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2 pb-8 -m-2">
            {CONTENT[panel]}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
