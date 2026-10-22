import { type LyricsPosition } from '@shared/settings'
import { motion } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fontOf, ensureFont } from '../fonts/catalog'
import { useLivePosition } from '../engine/clock'
import { usePlayer } from '../engine/store'
import { deriveAccent, rgbToHex } from '../theme/color'
import { useActiveAccents } from '../theme/store'
import { useSettings } from '../settings/store'
import { useUi } from '../ui/store'
import { parseLRC, wordProgress, type LyricLine } from './parse'
import { useLyrics } from './store'
import { PREVIEW_LYRICS } from './preview'

const LINE_HEIGHT = 58

function WordLine({
  line,
  time,
  active,
  color,
}: {
  line: LyricLine
  time: number
  active: boolean
  color: string
}): React.JSX.Element {
  const track = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = track.current
    if (!element) return
    const viewport = element.parentElement!
    let current = 0
    for (let i = 0; i < (line.words?.length ?? 0); i++) if (time >= line.words![i]!.t) current = i
    const word = element.children[current] as HTMLElement | undefined
    const center = word
      ? word.offsetLeft + word.offsetWidth * wordProgress(line.words![current]!, time)
      : 0
    const offset = active
      ? Math.max(
          0,
          Math.min(element.scrollWidth - viewport.clientWidth, center - viewport.clientWidth * 0.55)
        )
      : 0
    element.style.transform = `translateX(${-offset}px)`
  }, [line, time, active])
  return (
    <span
      className="block max-w-full overflow-hidden"
      style={{ filter: line.words?.length ? 'drop-shadow(0 2px 5px rgba(0,0,0,.65))' : undefined }}
    >
      <span
        ref={track}
        className="relative inline-block whitespace-pre"
        style={{ willChange: active ? 'transform' : undefined }}
      >
        {line.words?.length
          ? line.words.map((word, i) => {
              const p = active ? wordProgress(word, time) : time >= word.end ? 1 : 0
              return (
                <span
                  key={i}
                  data-lyric-word
                  style={{
                    color: 'transparent',
                    textShadow: 'none',
                    backgroundClip: 'text',
                    WebkitBackgroundClip: 'text',
                    backgroundImage: `linear-gradient(90deg, ${color} ${p * 100}%, rgba(255,255,255,.55) ${p * 100}%)`,
                  }}
                >
                  {word.text}
                </span>
              )
            })
          : line.text}
      </span>
    </span>
  )
}

export function Lyrics2D({
  frozenTime = null,
}: { frozenTime?: number | null } = {}): React.JSX.Element | null {
  const visible = useSettings((s) => s.lyricsVisible)
  const position = useSettings((s) => s.lyricsPosition)
  const offset = useSettings((s) => s.lyricsOffset)
  const fontId = useSettings((s) => s.lyricsFont)
  const size = useSettings((s) => s.lyricsSize) / 100
  const shadow = useSettings((s) => s.lyricsShadow)
  const adjusting = useUi((s) => s.lyricsAdjusting)
  const durationMs = usePlayer((s) => s.track?.durationMs ?? null)
  const live = useLivePosition(durationMs)
  const sourceText = useLyrics((s) => s.text)
  const preview = useUi((s) => s.lyricsPreview && s.onboardingOpen) && window.jap.surface === 'main'
  const text = preview ? PREVIEW_LYRICS : sourceText
  const { primary } = useActiveAccents()

  const lines = useMemo<LyricLine[]>(() => (text ? parseLRC(text) : []), [text])
  const fontDef = fontOf(fontId)
  const lineHeight = LINE_HEIGHT * size
  useEffect(() => {
    void ensureFont(fontId).catch(console.warn)
  }, [fontId])

  const currentTimeSec = (frozenTime ?? (preview ? 12000 : live)) / 1000
  const activeIndex = useMemo(() => {
    let idx = -1
    for (let i = 0; i < lines.length && lines[i]!.t <= currentTimeSec; i++) {
      idx = i
    }
    return idx
  }, [lines, currentTimeSec])

  const activeColor = useMemo(() => rgbToHex(deriveAccent(primary, 'dark').text), [primary])

  // 拖拽自定义位置
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{
    id: number
    element: HTMLDivElement
    start: { x: number; y: number }
    origin: { x: number; y: number }
    offset: { x: number; y: number }
    moved: boolean
  } | null>(null)
  const endDrag = useCallback(() => {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (current.element.hasPointerCapture(current.id))
      current.element.releasePointerCapture(current.id)
    if (current.moved)
      useSettings.getState().update({
        lyricsPosition: 'custom',
        lyricsOffset: { ...useSettings.getState().lyricsOffset, ...current.offset },
      })
    setDragOffset(null)
  }, [])
  useEffect(() => {
    const up = (e: PointerEvent): void => {
      if (e.pointerId === drag.current?.id) endDrag()
    }
    const visibility = (): void => {
      if (document.hidden) endDrag()
    }
    window.addEventListener('blur', endDrag)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', endDrag)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [endDrag])
  useEffect(() => {
    if (!adjusting) endDrag()
  }, [adjusting, endDrag])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!adjusting || e.button !== 0 || drag.current) return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const origin = {
        x: ((rect.left + rect.width / 2) / window.innerWidth) * 2 - 1,
        y: 1 - ((rect.top + rect.height / 2) / window.innerHeight) * 2,
      }
      drag.current = {
        id: e.pointerId,
        element: e.currentTarget,
        start: { x: e.clientX, y: e.clientY },
        origin,
        offset: origin,
        moved: false,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [adjusting]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const current = drag.current
      if (!current || e.pointerId !== current.id) return
      if (e.pointerType !== 'touch' && (e.buttons & 1) === 0) {
        endDrag()
        return
      }
      const dx = e.clientX - current.start.x,
        dy = e.clientY - current.start.y
      if (!current.moved && Math.hypot(dx, dy) < 3) return
      current.moved = true
      current.offset = {
        x: Math.min(0.95, Math.max(-0.95, current.origin.x + (dx / window.innerWidth) * 2)),
        y: Math.min(0.95, Math.max(-0.95, current.origin.y - (dy / window.innerHeight) * 2)),
      }
      setDragOffset(current.offset)
    },
    [endDrag]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerId === drag.current?.id) endDrag()
    },
    [endDrag]
  )

  if (!visible) return null

  const effectiveOffset = dragOffset ?? offset

  // 位置样式计算
  const getPositionClasses = (pos: LyricsPosition): string => {
    switch (pos) {
      case 'left':
        return 'left-16 top-1/2 items-start text-left'
      case 'right':
        return 'right-16 top-1/2 items-end text-right'
      case 'bottom':
        return 'inset-x-0 bottom-28 items-center text-center'
      case 'custom':
        return 'items-center text-center'
      case 'center':
      default:
        return 'left-1/2 top-1/2 items-center text-center'
    }
  }

  const customStyle: React.CSSProperties =
    position === 'custom' || dragOffset !== null
      ? {
          left: `${(effectiveOffset.x * 0.5 + 0.5) * 100}%`,
          top: `${(-effectiveOffset.y * 0.5 + 0.5) * 100}%`,
          transform: 'translate(-50%, -50%)',
        }
      : position === 'right' || position === 'left'
        ? {
            transform: `translate(${effectiveOffset.x || 0}px, calc(-50% + ${effectiveOffset.y || 0}px))`,
          }
        : position === 'center'
          ? {
              transform: `translate(calc(-50% + ${effectiveOffset.x || 0}px), calc(-50% + ${effectiveOffset.y || 0}px))`,
            }
          : {}

  // 阴影效果：深色强力投影 + 环境光晕，在任何背景下文字都轮廓清晰
  const textShadowStyle: React.CSSProperties = shadow
    ? {
        textShadow:
          '0 2px 10px rgba(0,0,0,0.92), 0 0 20px rgba(0,0,0,0.85), 0 4px 24px rgba(0,0,0,0.7), 0 0 3px rgba(0,0,0,0.95)',
      }
    : {}

  const activeShadowStyle: React.CSSProperties = shadow
    ? {
        textShadow: `0 2px 12px rgba(0,0,0,0.95), 0 0 24px ${activeColor}88, 0 0 4px rgba(0,0,0,0.9)`,
      }
    : {}

  // 底部极简条
  if (position === 'bottom') {
    const cur = activeIndex >= 0 ? lines[activeIndex] : null
    const nxt = activeIndex + 1 < lines.length ? lines[activeIndex + 1] : null

    return (
      <div
        className={`pointer-events-none absolute ${dragOffset ? '' : 'inset-x-0 bottom-32'} z-10 flex flex-col items-center justify-center px-8 transition-all ${
          adjusting ? 'pointer-events-auto cursor-grab' : ''
        }`}
        style={{
          fontFamily: `"${fontDef.family}", "Noto Sans SC", sans-serif`,
          touchAction: 'none',
          ...(dragOffset ? customStyle : {}),
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      >
        <div className="flex max-w-4xl flex-col items-center gap-1.5 drop-shadow-lg">
          {cur && (
            <motion.div
              key={activeIndex}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22 }}
              className="flex flex-col items-center gap-1"
            >
              <span
                className="text-2xl font-bold tracking-wide"
                style={{ color: activeColor, fontSize: 24 * size, ...activeShadowStyle }}
              >
                <WordLine line={cur} time={currentTimeSec} active color={activeColor} />
              </span>
              {cur.sub && (
                <span
                  className="text-sm font-medium text-white/80"
                  style={{ fontSize: 14 * size, ...textShadowStyle }}
                >
                  {cur.sub}
                </span>
              )}
            </motion.div>
          )}
          {nxt && (
            <span
              className="text-sm font-medium text-white/50"
              style={{ fontSize: 14 * size, ...textShadowStyle }}
            >
              {nxt.text}
            </span>
          )}
        </div>
      </div>
    )
  }

  // 滚动歌词视口
  return (
    <div
      className={`absolute z-10 flex flex-col select-none transition-[left,top] duration-75 ${
        adjusting
          ? 'pointer-events-auto cursor-grab ring-2 ring-accent/60 rounded-3xl p-6 bg-black/20 backdrop-blur-xs'
          : 'pointer-events-none'
      } ${getPositionClasses(dragOffset ? 'custom' : position)}`}
      style={{
        fontFamily: `"${fontDef.family}", "Noto Sans SC", sans-serif`,
        ...customStyle,
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
    >
      {adjusting && (
        <div className="mb-3 rounded-full bg-accent/80 px-3 py-1 text-xs font-medium text-on-accent shadow">
          按住歌词拖动 · 松开放下
        </div>
      )}

      {lines.length === 0 ? (
        <div className="text-sm text-white/60" style={textShadowStyle}>
          暂无歌词
        </div>
      ) : (
        <div className="relative h-[340px] w-[520px] overflow-hidden mask-linear-fade">
          <div
            className="flex flex-col transition-transform duration-300 ease-out"
            style={{
              transform: `translateY(${130 - (activeIndex >= 0 ? activeIndex : 0) * lineHeight}px)`,
            }}
          >
            {lines.map((line, idx) => {
              const isActive = idx === activeIndex
              const dist = Math.abs(idx - activeIndex)
              const opacity = isActive ? 1 : Math.max(0.15, 0.7 - dist * 0.16)

              return (
                <div
                  key={`${idx}-${line.t}`}
                  style={{ height: `${lineHeight}px` }}
                  className={`flex flex-col justify-center transition-all duration-200 ${
                    adjusting ? '' : 'pointer-events-auto cursor-pointer hover:opacity-100'
                  }`}
                  onClick={() => {
                    if (!adjusting) usePlayer.getState().seek(line.t * 1000)
                  }}
                >
                  <span
                    className={`block overflow-hidden whitespace-nowrap transition-all ${
                      isActive
                        ? 'text-[26px] font-bold tracking-wide'
                        : 'text-[19px] font-semibold text-white/90'
                    }`}
                    style={{
                      color: isActive ? activeColor : undefined,
                      opacity,
                      fontSize: (isActive ? 26 : 19) * size,
                      ...(isActive ? activeShadowStyle : textShadowStyle),
                    }}
                  >
                    <WordLine
                      line={line}
                      time={currentTimeSec}
                      active={isActive}
                      color={activeColor}
                    />
                  </span>
                  {line.sub && (
                    <span
                      className="text-xs font-medium text-white/75"
                      style={{ opacity: opacity * 0.9, fontSize: 12 * size, ...textShadowStyle }}
                    >
                      {line.sub}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
