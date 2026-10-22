import { Range } from './Range'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative m-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent' : 'bg-hover ring-1 ring-line'
      }`}
    >
      <motion.span
        initial={false}
        className="absolute top-0.5 size-5 rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.35)]"
        animate={{ left: checked ? 22 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 34 }}
      />
    </button>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled = false,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <Range
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent disabled:opacity-40"
      />
      <span className="w-12 shrink-0 text-right font-mono text-xs text-fg-muted">
        {format ? format(value) : value}
      </span>
    </div>
  )
}

/** 设置项的一行：左边标题与说明，右边控件。 */
export function SettingRow({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-fg-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SectionTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <h3 className="text-xs font-semibold tracking-wide text-fg-subtle">{children}</h3>
}
