import {
  ArrowsIn,
  ArrowsOut,
  CaretLeft,
  CaretRight,
  Gear,
  ListBullets,
  Palette,
  Quotes,
  Shuffle,
  SpeakerHigh,
  Waveform,
  SlidersHorizontal,
  MagnifyingGlass,
  DownloadSimple,
  FilmStrip,
} from '../icons'
import { useSceneRegistry } from '../viz/scenes'
import { useViz } from '../viz/store'
import { useUi, type PanelId } from '../ui/store'
import { useVideoQueue } from '../video/export'

const iconButton =
  'grid size-9 place-items-center rounded-full bg-black/30 text-white/85 ring-1 ring-white/12 backdrop-blur-md transition-colors hover:bg-black/45 hover:text-white'

/** 左上角的品牌标志：三根不等高的声波条，颜色跟随强调色。 */
function Logo(): React.JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgb(var(--accent))" />
          <stop offset="1" stopColor="rgb(var(--accent-2))" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="6.5" fill="url(#logo-g)" />
      <g fill="rgb(var(--on-accent))">
        <rect x="6.2" y="10" width="2.4" height="4.6" rx="1.2" />
        <rect x="10.8" y="6.6" width="2.4" height="10.8" rx="1.2" />
        <rect x="15.4" y="9" width="2.4" height="6.6" rx="1.2" />
      </g>
    </svg>
  )
}

function SceneSwitcher(): React.JSX.Element {
  const SCENES = useSceneRegistry((s) => s.scenes)
  const sceneId = useViz((s) => s.sceneId)
  const auto = useViz((s) => s.auto)
  const { step, setScene, setAuto } = useViz.getState()
  const scene = SCENES.find((s) => s.id === sceneId) ?? SCENES[0]!

  return (
    <div className="flex items-center gap-3">
      <button type="button" aria-label="上一个场景" className={iconButton} onClick={() => step(-1)}>
        <CaretLeft size={16} weight="bold" />
      </button>
      <div data-scene-caption className="min-w-0 w-20 xl:w-44">
        <div key={scene.id}>
          <div className="truncate font-display text-base font-semibold text-white drop-shadow">
            {scene.name}
          </div>
          <div className="truncate text-xs text-white/60">{scene.hint}</div>
        </div>
      </div>
      <button type="button" aria-label="下一个场景" className={iconButton} onClick={() => step(1)}>
        <CaretRight size={16} weight="bold" />
      </button>
      <div className="ml-1 hidden items-center gap-1.5 2xl:flex">
        {SCENES.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-label={s.name}
            title={s.name}
            onClick={() => setScene(s.id)}
            className={`h-1.5 rounded-full transition-all ${
              s.id === sceneId ? 'w-6 bg-white' : 'w-1.5 bg-white/35 hover:bg-white/60'
            }`}
          />
        ))}
      </div>
      <button
        type="button"
        aria-label="自动轮播场景"
        aria-pressed={auto}
        title="自动轮播"
        onClick={() => setAuto(!auto)}
        className={`${iconButton} ${auto ? 'bg-white/25 text-white ring-white/30' : ''}`}
      >
        <Shuffle size={16} weight={auto ? 'bold' : 'regular'} />
      </button>
    </div>
  )
}

const TOOLS: { id: PanelId; label: string; icon: typeof Waveform }[] = [
  { id: 'video', label: '导出视频', icon: DownloadSimple },
  { id: 'exports', label: '导出队列', icon: FilmStrip },
  { id: 'dsp', label: 'DSP / EQ', icon: SlidersHorizontal },
  { id: 'quality', label: '音源分析', icon: MagnifyingGlass },
  { id: 'signal', label: '信号链', icon: Waveform },
  { id: 'output', label: '输出', icon: SpeakerHigh },
  { id: 'playlist', label: '播放列表', icon: ListBullets },
  { id: 'lyrics', label: '歌词', icon: Quotes },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'settings', label: '设置', icon: Gear },
]

/** 右上角的图标工具栏：默认只显示图标，点开才出现对应面板。 */
function Toolbar(): React.JSX.Element {
  const queued = useVideoQueue(
    (s) => s.jobs.filter((j) => j.state === 'waiting' || j.state === 'rendering').length
  )
  const panel = useUi((s) => s.panel)
  const togglePanel = useUi((s) => s.togglePanel)
  const fullscreen = useViz((s) => s.fullscreen)

  return (
    <div className="no-drag glass flex items-center gap-1 rounded-2xl p-1.5">
      {TOOLS.map((tool) => {
        const active = panel === tool.id
        const Icon = tool.icon
        return (
          <button
            key={tool.id}
            type="button"
            data-toolbar
            data-toolbar-id={tool.id}
            aria-label={tool.label}
            aria-pressed={active}
            title={tool.label}
            onClick={() => togglePanel(tool.id)}
            className={`relative grid size-9 place-items-center rounded-xl transition-colors ${
              active ? 'bg-accent text-on-accent' : 'text-fg-muted hover:bg-hover hover:text-fg'
            }`}
          >
            <Icon size={18} weight={active ? 'fill' : 'regular'} />
            {tool.id === 'exports' && queued > 0 && (
              <span
                className="absolute -right-1 -top-1 rounded-full bg-accent px-1 text-[9px] text-on-accent"
                aria-label={`${queued} 个导出任务`}
              >
                {queued}
              </span>
            )}
          </button>
        )
      })}
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <button
        type="button"
        data-toolbar
        aria-label={fullscreen ? '退出全屏' : '全屏'}
        title={fullscreen ? '退出全屏 (Esc)' : '全屏 (F)'}
        onClick={() => useViz.getState().setFullscreen(!fullscreen)}
        className="grid size-9 place-items-center rounded-xl text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        {fullscreen ? <ArrowsIn size={18} weight="bold" /> : <ArrowsOut size={18} weight="bold" />}
      </button>
    </div>
  )
}

/** 顶部悬浮层：左边是品牌与场景，右边是工具栏；右侧留出系统窗口按钮的位置。 */
export function TopBar({ visible }: { visible: boolean }): React.JSX.Element {
  const fullscreen = useViz((s) => s.fullscreen)
  return (
    <>
      <header
        data-player-topbar
        className={`drag-region absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 px-4 pb-2 pt-3 ${window.jap.platform === 'darwin' && !fullscreen ? 'pl-28 pr-4' : 'pr-44'} transition-opacity duration-300 ${
          visible ? '' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="no-drag flex min-w-0 items-center gap-4">
          <div className="flex shrink-0 items-center gap-2.5">
            <Logo />
            <span className="hidden 2xl:inline font-display text-[13px] font-semibold tracking-wide text-white/80">
              Just A Player
            </span>
          </div>
          <SceneSwitcher />
        </div>
        <Toolbar />
      </header>
      {!fullscreen && (
        <button
          data-mini-entry
          type="button"
          aria-label="悬浮播放"
          title="收起为小窗"
          onClick={() => {
            void window.jap.setWindowMode('mini')
          }}
          className={`no-drag absolute ${window.jap.platform === 'darwin' ? 'left-[76px]' : 'right-[142px]'} top-1.5 z-50 grid size-8 place-items-center rounded-lg text-fg-muted hover:bg-hover`}
        >
          <ArrowsIn size={16} />
        </button>
      )}
    </>
  )
}
