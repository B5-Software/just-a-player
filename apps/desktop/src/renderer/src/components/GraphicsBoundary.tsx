import { Component, Fragment, type ReactNode } from 'react'
import { useCover } from '../cover/store'
import { Lyrics2D } from '../lyrics/Lyrics2D'
import { CoverFade } from './CoverFade'

/** A failed GPU layer must never unmount the player or its audio controls. */
export class GraphicsBoundary extends Component<
  { children: ReactNode; fallback: (retry: () => void) => ReactNode },
  { failed: boolean; generation: number }
> {
  state = { failed: false, generation: 0 }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: Error): void {
    console.warn('[graphics] Keeping player controls available:', error)
  }
  private retry = (): void =>
    this.setState((state) => ({ failed: false, generation: state.generation + 1 }))
  render(): ReactNode {
    return this.state.failed ? (
      this.props.fallback(this.retry)
    ) : (
      <Fragment key={this.state.generation}>{this.props.children}</Fragment>
    )
  }
}

export function CoverBackdrop(): React.JSX.Element {
  const art = useCover((state) => state.art)
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        background: 'linear-gradient(135deg,rgb(var(--accent)/.4),rgb(var(--accent-2)/.35)),#252433'
      }}
    >
      {art && (
        <div className="absolute -inset-8 opacity-70 blur-2xl">
          <CoverFade src={art.url} />
        </div>
      )}
    </div>
  )
}

export function StageFallback({ retry }: { retry: () => void }): React.JSX.Element {
  return (
    <div data-graphics-fallback className="absolute inset-0">
      <CoverBackdrop />
      <Lyrics2D />
      <div className="glass absolute bottom-48 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-2xl px-4 py-3 text-xs text-fg">
        <span>3D 效果暂不可用 · 音频与播放控制仍可使用</span>
        <button
          type="button"
          onClick={retry}
          className="shrink-0 rounded-lg bg-accent px-3 py-2 text-on-accent"
        >
          重试 3D
        </button>
      </div>
    </div>
  )
}
