import { useEffect, useMemo, useRef } from 'react'
import { useSettings } from '../settings/store'
import { deriveAccent, rgbToHex } from '../theme/color'
import { useActiveAccents } from '../theme/store'
import { useUi } from '../ui/store'
import { Lyrics2D } from './Lyrics2D'
import { LyricsRenderer, type LyricsStyle } from './renderer'
import { useLyrics } from './store'
export let activeLyricsRenderer: LyricsRenderer | null = null

/** 歌词叠在深色舞台上：当前行用强调色的亮色版本，其余行用浅色，保证可读。 */
const INACTIVE_TEXT = '#d9deff'
const PREVIEW_LYRICS = `[00:00.00]让音乐在这里流动
[00:05.00]布置属于你的舞台
[00:10.00]按住这行测试歌词拖动
[00:15.00]松开鼠标即可放下
[00:20.00]位置与旋转会自动保存`

function Lyrics3D(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<LyricsRenderer | null>(null)
  const text = useLyrics((s) => s.text)
  const adjusting = useUi((s) => s.lyricsAdjusting)
  const preview = useUi((s) => s.lyricsPreview && s.onboardingOpen) && window.jap.surface === 'main'
  const { primary } = useActiveAccents()
  const activeText = useMemo(() => rgbToHex(deriveAccent(primary, 'dark').text), [primary])
  const visible = useSettings((s) => s.lyricsVisible)
  const position = useSettings((s) => s.lyricsPosition)
  const offset = useSettings((s) => s.lyricsOffset)
  const pose = useSettings((s) => s.lyricsPose)
  const rotation = useSettings((s) => s.lyricsRotation)
  const spin = useSettings((s) => s.lyricsSpin)
  const font = useSettings((s) => s.lyricsFont)
  const shadow = useSettings((s) => s.lyricsShadow)
  const size = useSettings((s) => s.lyricsSize)

  const style = useMemo<LyricsStyle>(
    () => ({
      visible,
      font,
      position,
      offset,
      pose,
      rotation,
      spin,
      active: activeText,
      inactive: INACTIVE_TEXT,
      shadow,
      size
    }),
    [visible, font, position, offset, pose, rotation, spin, activeText, shadow, size]
  )

  useEffect(() => {
    const renderer = new LyricsRenderer(hostRef.current!, (next) => {
      useSettings.getState().update({
        lyricsPosition: 'custom',
        lyricsOffset: { ...useSettings.getState().lyricsOffset, ...next }
      })
    })
    rendererRef.current = renderer
    activeLyricsRenderer = renderer
    if (new URLSearchParams(location.search).has('e2e'))
      (window as unknown as Record<string, unknown>)['__japLyrics'] = renderer
    return () => {
      renderer.dispose()
      rendererRef.current = null
      activeLyricsRenderer = null
    }
  }, [])

  useEffect(() => {
    rendererRef.current?.setStyle(style)
  }, [style])

  useEffect(() => {
    rendererRef.current?.setPreview(preview)
    rendererRef.current?.setText(preview ? PREVIEW_LYRICS : text)
  }, [text, preview])

  useEffect(() => {
    rendererRef.current?.setInteractive(adjusting)
  }, [adjusting])

  return <div ref={hostRef} className="pointer-events-none absolute inset-0 z-[2]" />
}

export function LyricsLayer(): React.JSX.Element | null {
  const visible = useSettings((s) => s.lyricsVisible)
  const mode = useSettings((s) => s.lyricsMode)

  if (!visible) return null
  // Wallpaper 2D text is composed in each monitor region; 3D is rendered once.
  if (mode === '2d' && window.jap.surface === 'wallpaper') return null
  return mode === '2d' ? <Lyrics2D /> : <Lyrics3D />
}
