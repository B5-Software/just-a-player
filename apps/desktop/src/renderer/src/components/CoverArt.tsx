import { useCover } from '../cover/store'
import { MusicNotes } from '../icons'
import { CoverFade } from './CoverFade'

/** 当前曲目的封面：有封面就显示封面，没有就沿用强调色渐变的音符占位。 */
export function CoverArt({ size }: { size: number }): React.JSX.Element {
  const art = useCover((s) => s.art)
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-2xl ring-1 ring-white/15 shadow-[0_24px_60px_-20px_rgb(var(--accent)/0.6)]"
      style={{ width: size, height: size }}
    >
      {art ? (
        <CoverFade src={art.url} />
      ) : (
        <div
          key="placeholder"
          className="absolute inset-0 grid place-items-center"
          style={{
            background:
              'linear-gradient(145deg, rgb(var(--accent) / 0.9), rgb(var(--accent-2) / 0.75))'
          }}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgb(255_255_255/0.35),transparent_55%)]" />
          <MusicNotes
            size={size * 0.4}
            weight="duotone"
            className="relative text-on-accent opacity-85"
          />
        </div>
      )}
    </div>
  )
}
