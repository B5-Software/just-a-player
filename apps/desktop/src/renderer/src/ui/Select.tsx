import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'multiple' | 'size'> & {
  onChange?: (event: { target: { value: string } }) => void
}
interface Option {
  value: string
  label: ReactNode
  disabled: boolean
}
/** Shared styled listbox: Android never invokes WebView's platform select dialog. */
export function Select({
  children,
  value,
  defaultValue,
  onChange,
  className = '',
  disabled,
  id,
  ...attributes
}: Props): React.JSX.Element {
  const options = Children.toArray(children).flatMap((child): Option[] => {
    if (
      !isValidElement<{
        value?: string | number
        children?: ReactNode
        disabled?: boolean
      }>(child)
    )
      return []
    return [
      {
        value: String(child.props.value ?? ''),
        label: child.props.children,
        disabled: !!child.props.disabled,
      },
    ]
  })
  const [internal, setInternal] = useState(String(defaultValue ?? options[0]?.value ?? ''))
  const current = String(value ?? internal),
    selected = options.find((o) => o.value === current)
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(0)
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    height: 280,
  })
  const button = useRef<HTMLButtonElement>(null),
    list = useRef<HTMLDivElement>(null),
    listId = useId()
  const show = (): void => {
    if (disabled || !button.current) return
    const r = button.current.getBoundingClientRect(),
      below = innerHeight - r.bottom - 12,
      above = r.top - 12
    const height = Math.min(300, Math.max(100, Math.max(below, above)))
    setPosition({
      top:
        below >= Math.min(300, options.length * 44 + 12) || below >= above
          ? r.bottom + 6
          : Math.max(8, r.top - Math.min(height, options.length * 44 + 12) - 6),
      left: Math.max(8, Math.min(r.left, innerWidth - r.width - 8)),
      width: Math.min(innerWidth - 16, Math.max(160, r.width)),
      height,
    })
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === current)
      )
    )
    setOpen(true)
  }
  const choose = (index: number): void => {
    const item = options[index]
    if (!item || item.disabled) return
    setInternal(item.value)
    onChange?.({ target: { value: item.value } })
    setOpen(false)
    button.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    list.current?.focus()
    const pointer = (e: PointerEvent): void => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
        setOpen(false)
    }
    const resize = (): void => setOpen(false)
    window.addEventListener('pointerdown', pointer, true)
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('pointerdown', pointer, true)
      window.removeEventListener('resize', resize)
    }
  }, [open])
  useEffect(() => {
    list.current
      ?.querySelector(`[data-option-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, active])
  return (
    <>
      <button
        {...(attributes as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        ref={button}
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
            e.preventDefault()
            show()
          }
        }}
        className={`flex items-center justify-between gap-3 text-left ${className}`}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? '选择…'}</span>
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="block h-4 w-4 shrink-0 text-fg-subtle"
          fill="none"
        >
          <path
            d="m5 7.5 5 5 5-5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            data-panel-portal
            ref={list}
            id={listId}
            tabIndex={0}
            role="listbox"
            aria-label={attributes['aria-label']}
            aria-activedescendant={`${listId}-${active}`}
            style={{
              position: 'fixed',
              zIndex: 1200,
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: position.height,
            }}
            className="glass panel-surface overflow-y-auto overscroll-contain rounded-2xl p-1.5 shadow-2xl"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                button.current?.focus()
                return
              }
              if (e.key === 'Tab') {
                setOpen(false)
                return
              }
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                choose(active)
                return
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                e.preventDefault()
                let index = e.key === 'Home' ? -1 : e.key === 'End' ? options.length : active
                const direction = e.key === 'ArrowUp' || e.key === 'End' ? -1 : 1
                for (let n = 0; n < options.length; n++) {
                  index = (index + direction + options.length) % options.length
                  if (!options[index]?.disabled) break
                }
                setActive(index)
              }
            }}
          >
            {options.map((option, index) => (
              <div
                key={`${option.value}-${index}`}
                id={`${listId}-${index}`}
                data-option-index={index}
                role="option"
                aria-selected={current === option.value}
                aria-disabled={option.disabled}
                onPointerMove={() => {
                  if (!option.disabled) setActive(index)
                }}
                onClick={() => choose(index)}
                className={`flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-xs ${option.disabled ? 'cursor-not-allowed opacity-35' : index === active ? 'bg-accent/15 text-accent-text' : 'text-fg-muted hover:bg-hover'}`}
              >
                <span>{option.label}</span>
                {current === option.value && <span aria-hidden>✓</span>}
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
