import type { ComponentType, ReactNode } from 'react'
import { motion } from 'motion/react'
import { useId } from 'react'

export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: ComponentType<{ size?: number; weight?: 'regular' | 'fill' | 'bold' }>
}

interface SegmentedProps<T extends string> {
  value: T
  options: readonly SegmentOption<T>[]
  onChange: (value: T) => void
  'aria-label': string
  size?: 'sm' | 'md'
  className?: string
  children?: ReactNode
}

/** 带滑动高亮块的分段控件。 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className = '',
  ...rest
}: SegmentedProps<T>): React.JSX.Element {
  const group = useId()
  const pad = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm'

  return (
    <div
      role="radiogroup"
      aria-label={rest['aria-label']}
      className={`relative inline-flex rounded-xl bg-hover p-1 ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`relative z-10 inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors ${pad} ${
              active ? 'text-fg' : 'text-fg-muted hover:text-fg'
            }`}
          >
            {active && (
              <motion.span
                initial={false}
                layoutId={`seg-${group}`}
                className="absolute inset-0 -z-10 rounded-lg bg-surface shadow-[0_1px_6px_rgb(0_0_0/0.25)] ring-1 ring-line"
                transition={{ type: 'spring', stiffness: 520, damping: 38 }}
              />
            )}
            {Icon && <Icon size={size === 'sm' ? 14 : 16} weight={active ? 'fill' : 'regular'} />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
