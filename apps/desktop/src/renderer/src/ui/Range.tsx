import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react'
interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'onInput'> {
  min?: number
  max?: number
  step?: number
  value?: number | string
  disabled?: boolean
  vertical?: boolean
  onChange?: (event: { target: { value: string } }) => void
  onCommit?: (value: number) => void
  onCancel?: () => void
}
/** A tap never changes a touch slider. Vertical EQ faders require a brief hold. */
export function Range({
  min = 0,
  max = 100,
  step = 1,
  value = 0,
  disabled = false,
  vertical = false,
  onChange,
  onCommit,
  onCancel,
  className = '',
  style,
  ...attributes
}: Props): React.JSX.Element {
  const number = Number(value),
    span = Math.max(0, max - min)
  const fraction = span ? Math.max(0, Math.min(1, (number - min) / span)) : 0
  const gesture = useRef<{
    id: number
    x: number
    y: number
    origin: number
    latest: number
    start: number
    touch: boolean
    active: boolean
    scrolling: boolean
    scroll: HTMLElement | null
    scrollTop: number
  } | null>(null)
  const [active, setActive] = useState(false)
  const elementRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<() => void>(() => {})
  const normalize = (n: number): number =>
    Math.min(max, Math.max(min, Number((min + Math.round((n - min) / step) * step).toFixed(8))))
  const change = (n: number): void => {
    const v = normalize(n)
    if (gesture.current) gesture.current.latest = v
    onChange?.({ target: { value: String(v) } })
  }
  const end = (element: HTMLElement, cancelled: boolean): void => {
    const g = gesture.current
    if (!g) return
    gesture.current = null
    setActive(false)
    if (element.hasPointerCapture(g.id)) element.releasePointerCapture(g.id)
    if (!cancelled && g.active) onCommit?.(g.latest)
    else onCancel?.()
  }
  cancelRef.current = () => {
    if (elementRef.current) end(elementRef.current, true)
  }
  useEffect(() => {
    const cancel = (): void => cancelRef.current()
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [])
  return (
    <div
      {...attributes}
      ref={elementRef}
      data-range
      data-range-vertical={vertical ? '1' : undefined}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={number}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={`jap-range ${className} ${active ? 'is-dragging' : ''} ${disabled ? 'opacity-40' : ''}`}
      style={
        {
          ...style,
          touchAction: vertical ? 'none' : 'pan-y',
          writingMode: 'horizontal-tb',
          direction: 'ltr',
        } as CSSProperties
      }
      onPointerDown={(e) => {
        if (disabled || span <= 0 || e.button !== 0 || !e.isPrimary || gesture.current) return
        const r = e.currentTarget.getBoundingClientRect(),
          touch = e.pointerType === 'touch'
        let parent = e.currentTarget.parentElement
        while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement
        gesture.current = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          origin: number,
          latest: number,
          start: e.timeStamp,
          touch,
          active: !touch,
          scrolling: false,
          scroll: parent,
          scrollTop: parent?.scrollTop ?? 0,
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        if (!touch) {
          e.preventDefault()
          e.currentTarget.focus()
          setActive(true)
          change(
            min +
              (vertical ? (r.bottom - e.clientY) / r.height : (e.clientX - r.left) / r.width) * span
          )
        }
      }}
      onPointerMove={(e) => {
        const g = gesture.current
        if (!g || g.id !== e.pointerId) return
        if (!g.touch && !(e.buttons & 1)) {
          end(e.currentTarget, true)
          return
        }
        const dx = e.clientX - g.x,
          dy = e.clientY - g.y,
          along = vertical ? -dy : dx,
          across = vertical ? dx : dy
        if (g.scrolling) {
          if (g.scroll) g.scroll.scrollTop = g.scrollTop - dy
          return
        }
        if (!g.active) {
          // Even a slow continuous swipe belongs to scrolling. It must not turn
          // into a fader drag simply because its total duration exceeds the hold.
          const firstMove = e.nativeEvent.getCoalescedEvents?.()[0] ?? e.nativeEvent
          const elapsed = firstMove.timeStamp - g.start
          if (vertical && Math.hypot(dx, dy) > 3 && elapsed < 220) {
            g.scrolling = true
            if (g.scroll) g.scroll.scrollTop = g.scrollTop - dy
            return
          }
          if (vertical && elapsed < 220) return
          if (Math.abs(along) < 10 || Math.abs(along) < Math.abs(across) * 1.4) return
          g.active = true
          setActive(true)
        }
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        change(
          g.touch
            ? g.origin + (along / (vertical ? r.height : r.width)) * span
            : min +
                (vertical ? (r.bottom - e.clientY) / r.height : (e.clientX - r.left) / r.width) *
                  span
        )
      }}
      onPointerUp={(e) => {
        if (e.pointerId === gesture.current?.id) end(e.currentTarget, false)
      }}
      onPointerCancel={(e) => {
        if (e.pointerId === gesture.current?.id) end(e.currentTarget, true)
      }}
      onLostPointerCapture={(e) => {
        if (e.pointerId === gesture.current?.id) end(e.currentTarget, true)
      }}
      onKeyDown={(e) => {
        if (disabled) return
        const target =
          e.key === 'Home'
            ? min
            : e.key === 'End'
              ? max
              : ['ArrowRight', 'ArrowUp'].includes(e.key)
                ? number + step
                : ['ArrowLeft', 'ArrowDown'].includes(e.key)
                  ? number - step
                  : e.key === 'PageUp'
                    ? number + span / 10
                    : e.key === 'PageDown'
                      ? number - span / 10
                      : null
        if (target === null) return
        e.preventDefault()
        change(target)
        onCommit?.(normalize(target))
      }}
    >
      <span className="jap-range-track" aria-hidden>
        <span
          className="jap-range-fill"
          style={vertical ? { height: `${fraction * 100}%` } : { width: `${fraction * 100}%` }}
        />
      </span>
      <span
        className="jap-range-thumb"
        aria-hidden
        style={vertical ? { bottom: `${fraction * 100}%` } : { left: `${fraction * 100}%` }}
      />
    </div>
  )
}
