import { ui, useLocale } from '../i18n'
import { baseName } from '@shared/audio'
import { usePlayer } from '../engine/store'
import { channelLabel, describeFormat } from '../lib/format'
import { stripExtension } from '../lib/text'
import { TONE_CLASS, VERDICT_LABEL } from '../lib/verdict'
import { Repeat, RepeatOnce, Shuffle, ArrowCounterClockwise } from '../icons'
import { activeListOf, displayTitle, useLibrary, type RepeatMode } from '../library/store'
import { pendingItem } from '../library/playback'
import { CoverArt } from './CoverArt'
import { SeekBar } from './SeekBar'
import { Transport } from './Transport'
import { VolumeControl } from './VolumeControl'
import { useUi } from '../ui/store'
import { useExternal, setExternalMode } from '../external/store'

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' }
const REPEAT_LABEL: Record<RepeatMode, string> = { off: '不循环', all: '列表循环', one: '单曲循环' }

function compactCodec(codec: string): string {
  const parts = codec.split(' / ')
  return (parts[0] === '网易云' || parts[0] === 'NCM' ? parts[1] ?? parts[0] : parts[0] ?? codec)
    .split(' · ')[0]!
}

/** 左下角：封面优先，旁边是曲目信息与格式标签。 */
function NowPlaying(): React.JSX.Element {
  useLocale()
  const track = usePlayer((s) => s.track)
  const verdict = usePlayer((s) => s.signalPath?.verdict)
  const tone = verdict ? VERDICT_LABEL[verdict] : null
  const listName = useLibrary((s) => activeListOf(s).name)
  const upcoming = useLibrary(pendingItem)

  return (
    ui(<div data-now-playing className="flex min-w-0 items-center gap-4">
      <CoverArt size={104} />
      <div className="flex min-w-0 flex-col gap-1.5">
        {track ? (
          <>
            <h1 translate="no" className="truncate font-display text-xl font-semibold leading-tight">
              {track.title ?? stripExtension(baseName(track.path))}
            </h1>
            <p translate={track.artist || track.album ? 'no' : undefined} className="truncate text-sm text-fg-muted">
              {[track.artist, track.album].filter(Boolean).join('  ·  ') || '未知艺术家'}
            </p>
            <div data-track-tags className="flex min-w-0 items-center gap-2 pt-0.5 text-[11px] text-fg-muted">
              <span className="min-w-0 truncate" title={`${track.codec} · ${describeFormat(track.format)} · ${channelLabel(track.format.channels)}`}>
                {compactCodec(track.codec)} · {describeFormat(track.format)} · {channelLabel(track.format.channels)}
              </span>
              {tone && (
                <button type="button" aria-label="查看信号链" title={tone.text}
                  onClick={() => useUi.getState().togglePanel('signal')}
                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ${TONE_CLASS[tone.tone]}`}>
                  {tone.text}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <h1
              translate="no"
              title={listName}
              className="truncate font-display text-xl font-semibold leading-tight"
            >
              {listName}
            </h1>
            <p className="text-sm text-fg-muted">
              {upcoming
                ? `待播放 · ${displayTitle(upcoming)}`
                : '把音频文件或文件夹拖进来，或点击下方的文件夹图标。'}
            </p>
          </>
        )}
      </div>
    </div>)
  )
}

function PlayModes(): React.JSX.Element {
  useLocale()
  const external = useExternal(s => s)
  const owns = external.phase === 'routing' || external.snapshot?.devices?.currentDevice.name === 'Just A Player HiFi Bridge (Black Hole)'
  const localRepeat = useLibrary((s) => s.repeat)
  const localShuffle = useLibrary((s) => s.shuffle)
  const mode = external.snapshot?.mode
  const repeat = owns ? (mode === 'off' ? 'off' : mode === 'one' ? 'one' : 'all') : localRepeat
  const shuffle = owns ? mode === 'shuffle' : localShuffle
  const setRepeat = useLibrary((s) => s.setRepeat)
  const setShuffle = useLibrary((s) => s.setShuffle)
  const RepeatIcon = repeat === 'one' ? RepeatOnce : Repeat

  return (
    ui(<div className="flex items-center gap-2">
      <button
        type="button"
        aria-label="快捷重置音频缓冲"
        title="重置音频缓冲"
        onClick={() => usePlayer.getState().resetBuffer()}
        className="grid size-10 place-items-center rounded-full text-fg-muted hover:bg-hover"
      >
        <ArrowCounterClockwise size={18} />
      </button>
      <button
        type="button"
        aria-label={`循环模式：${REPEAT_LABEL[repeat]}`}
        title={REPEAT_LABEL[repeat]}
        onClick={() => owns ? setExternalMode(NEXT_REPEAT[repeat]) : setRepeat(NEXT_REPEAT[repeat])}
        className={`grid size-10 place-items-center rounded-full transition-colors hover:bg-hover ${
          repeat === 'off' ? 'text-fg-muted' : 'text-accent-text'
        }`}
      >
        <RepeatIcon size={20} weight={repeat === 'off' ? 'regular' : 'bold'} />
      </button>
      <button
        type="button"
        aria-label="随机播放"
        aria-pressed={shuffle}
        title="随机播放"
        onClick={() => owns ? setExternalMode(shuffle ? 'all' : 'shuffle') : setShuffle(!shuffle)}
        className={`grid size-10 place-items-center rounded-full transition-colors hover:bg-hover ${
          shuffle ? 'text-accent-text' : 'text-fg-muted'
        }`}
      >
        <Shuffle size={20} weight={shuffle ? 'bold' : 'regular'} />
      </button>
    </div>)
  )
}

/** 底部悬浮控制坞：封面与信息在左，进度与传输控制在中，播放模式在右。 */
export function Dock({ visible }: { visible: boolean }): React.JSX.Element {
  useLocale()
  return (
    ui(<div
      data-player-dock
      className={`absolute inset-x-6 bottom-6 z-20 transition-opacity duration-300 ${
        visible ? '' : 'pointer-events-none opacity-0'
      }`}
    >
      <div className="glass mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)] items-center gap-6 rounded-[32px] p-5">
        <NowPlaying />
        <div data-dock-transport className="flex min-w-0 flex-col gap-3">
          <SeekBar />
          <Transport />
        </div>
        <div data-dock-tools className="flex flex-col items-end gap-2">
          <PlayModes />
          <VolumeControl />
        </div>
      </div>
    </div>)
  )
}
