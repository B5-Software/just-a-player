import type { ThemeMode } from '@shared/theme'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useCover } from '../cover/store'
import { ArrowCounterClockwise, Check, Monitor, Moon, Sun } from '../icons'
import { useSettings } from '../settings/store'
import { normalizeHex } from '../theme/color'
import { ACCENT_PRESETS, DEFAULT_ACCENT, useTheme } from '../theme/store'
import { Slider, SectionTitle, SettingRow, Toggle } from '../ui/controls'
import { useViz } from '../viz/store'
import { Segmented, type SegmentOption } from './Segmented'

const MODE_OPTIONS: readonly SegmentOption<ThemeMode>[] = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon }
]

/** 外观：主题、强调色（可自动取封面色），以及封面模糊背景与亮度。 */
export function AppearancePanel(): React.JSX.Element {
  const mode = useTheme((s) => s.mode)
  const accent = useTheme((s) => s.accent)
  const setMode = useTheme((s) => s.setMode)
  const setAccent = useTheme((s) => s.setAccent)
  const resetAccent = useTheme((s) => s.resetAccent)
  const palette = useCover((s) => s.palette)
  const autoAccent = useSettings((s) => s.autoAccent)
  const autoBackdrop = useSettings((s) => s.autoBackdrop)
  const brightness = useSettings((s) => s.backdropBrightness)
  const update = useSettings((s) => s.update)

  const vizOffset = useViz((s) => s.offset)
  const vizZoom = useViz((s) => s.zoom)
  const setVizOffset = useViz((s) => s.setOffset)
  const setVizZoom = useViz((s) => s.setZoom)
  const resetVizPosition = useViz((s) => s.resetPosition)

  const [draft, setDraft] = useState(accent)
  useEffect(() => setDraft(accent), [accent])

  const commitDraft = (): void => {
    const hex = normalizeHex(draft)
    if (hex) setAccent(hex)
    else setDraft(accent)
  }

  const isPreset = ACCENT_PRESETS.some((p) => p.hex === accent)

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2.5">
        <SectionTitle>主题</SectionTitle>
        <Segmented
          aria-label="主题模式"
          size="sm"
          value={mode}
          options={MODE_OPTIONS}
          onChange={setMode}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <SectionTitle>强调色</SectionTitle>
          {!autoAccent && accent !== DEFAULT_ACCENT && (
            <button
              type="button"
              onClick={resetAccent}
              className="inline-flex items-center gap-1 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              <ArrowCounterClockwise size={12} />
              恢复默认
            </button>
          )}
        </div>
        <SettingRow
          title="自动取色"
          hint={
            autoAccent
              ? palette
                ? '跟随当前封面的两种颜色'
                : '没有封面，暂用手动颜色'
              : '正在使用手动颜色；选择颜色会关闭自动取色'
          }
        >
          <Toggle
            checked={autoAccent}
            onChange={(v) => update({ autoAccent: v })}
            label="自动取色"
          />
        </SettingRow>

        <div
          className={`flex flex-col gap-2.5 transition-opacity ${autoAccent && palette ? 'opacity-60' : ''}`}
        >
          <div className="grid grid-cols-8 gap-2 p-2">
            {ACCENT_PRESETS.map((preset) => {
              const active = preset.hex === accent
              return (
                <button
                  key={preset.hex}
                  type="button"
                  title={preset.name}
                  aria-label={preset.name}
                  aria-pressed={active}
                  onClick={() => setAccent(preset.hex)}
                  style={{ backgroundColor: preset.hex }}
                  className="relative grid aspect-square place-items-center rounded-full transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {active && (
                    <motion.span
                      initial={false}
                      layoutId="accent-ring"
                      className="pointer-events-none absolute -inset-1 rounded-full border-2 border-fg"
                      transition={{ type: 'spring', stiffness: 520, damping: 36 }}
                    />
                  )}
                  {active && (
                    <Check size={12} weight="bold" className="text-white mix-blend-difference" />
                  )}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-2.5 p-0.5">
            <label
              className={`relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-xl ring-1 ring-line ${
                isPreset ? '' : 'ring-2 ring-fg'
              }`}
              style={{ backgroundColor: accent }}
              title="自定义颜色"
            >
              <input
                type="color"
                aria-label="自定义强调色"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </label>
            <input
              value={draft}
              spellCheck={false}
              aria-label="强调色十六进制值"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="min-w-0 flex-1 rounded-xl bg-hover px-3 py-2 font-mono text-sm uppercase text-fg outline-none ring-1 ring-transparent transition-shadow focus:ring-accent"
            />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>背景</SectionTitle>
        <SettingRow
          title="封面模糊背景"
          hint="把当前封面模糊后作为 3D 场景的底图；没有封面时保持现在的背景"
        >
          <Toggle
            checked={autoBackdrop}
            onChange={(v) => update({ autoBackdrop: v })}
            label="封面模糊背景"
          />
        </SettingRow>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-muted">背景亮度</span>
          <Slider
            label="背景亮度"
            value={brightness}
            min={0}
            max={1}
            step={0.01}
            disabled={!autoBackdrop}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => update({ backdropBrightness: v })}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <SectionTitle>3D 视效位置</SectionTitle>
          {(vizOffset.x !== 0 || vizOffset.y !== 0 || vizZoom !== 1) && (
            <button
              type="button"
              onClick={resetVizPosition}
              className="inline-flex items-center gap-1 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              <ArrowCounterClockwise size={12} />
              复位居中
            </button>
          )}
        </div>
        <p className="text-xs leading-relaxed text-fg-muted">
          可在主画面任意位置按住鼠标自由拖拽移动视效，滚轮缩放，双击舞台快速复位居中。
        </p>
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">水平偏移 (X)</span>
            <Slider
              label="视效水平偏移"
              value={vizOffset.x}
              min={-500}
              max={500}
              step={2}
              format={(v) => `${v}px`}
              onChange={(v) => setVizOffset((prev) => ({ ...prev, x: v }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">垂直偏移 (Y)</span>
            <Slider
              label="视效垂直偏移"
              value={vizOffset.y}
              min={-400}
              max={400}
              step={2}
              format={(v) => `${v}px`}
              onChange={(v) => setVizOffset((prev) => ({ ...prev, y: v }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">视角缩放</span>
            <Slider
              label="视效缩放"
              value={vizZoom}
              min={0.5}
              max={2.5}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => setVizZoom(v)}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
