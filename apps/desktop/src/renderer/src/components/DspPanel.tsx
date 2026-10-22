import { Range } from '../ui/Range'
import { Select } from '../ui/Select'
import { useState } from 'react'
import type { DspConfig } from '@shared/protocol/DspConfig'
import { DEFAULT_DSP, DSP_PRESETS, EQ_HZ, useDsp } from '../audio/dsp-store'
import { usePlayer } from '../engine/store'
import { Toggle } from '../ui/controls'

function Slider({
  label,
  value,
  min,
  max,
  step = 0.1,
  unit = '',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-2 text-xs text-fg-muted">
      <span className="flex justify-between">
        <span>{label}</span>
        <output className="font-mono text-fg">
          {value.toFixed(1)}
          {unit}
        </output>
      </span>
      <Range
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[rgb(var(--accent))]"
      />
    </label>
  )
}

function response(gains: number[], rate: number): string {
  return Array.from({ length: 140 }, (_, i) => {
    const hz = 20 * 1000 ** (i / 139)
    const w = (2 * Math.PI * hz) / rate
    let db = 0
    EQ_HZ.forEach((center, band) => {
      const a = 10 ** (gains[band]! / 40)
      const wc = (2 * Math.PI * Math.min(center, rate * 0.45)) / rate
      const alpha = Math.sin(wc) / 2.8
      const b = [1 + alpha * a, -2 * Math.cos(wc), 1 - alpha * a]
      const d = [1 + alpha / a, -2 * Math.cos(wc), 1 - alpha / a]
      const mag = (c: number[]): number =>
        (c[0]! + c[1]! * Math.cos(w) + c[2]! * Math.cos(2 * w)) ** 2 +
        (c[1]! * Math.sin(w) + c[2]! * Math.sin(2 * w)) ** 2
      db += 10 * Math.log10(Math.max(1e-20, mag(b) / mag(d)))
    })
    return `${i ? 'L' : 'M'}${((i / 139) * 460).toFixed(1)},${(48 - Math.max(-15, Math.min(15, db)) * 2.6).toFixed(1)}`
  }).join(' ')
}

export function DspPanel(): React.JSX.Element {
  const config = useDsp((s) => s.config)
  const update = useDsp((s) => s.update)
  const dsd = usePlayer(
    (s) => s.track?.format.bits === 1 && s.output.dsdMode !== 'pcm' && s.state !== 'stopped'
  )
  const rate = usePlayer((s) => s.track?.format.sampleRate ?? 48000)
  const [custom, setCustom] = useState<{ name: string; patch: Partial<DspConfig> }[]>(() => {
    try {
      const data = JSON.parse(localStorage.getItem('jap.dsp.presets') ?? '[]')
      return Array.isArray(data)
        ? data.filter(
            (x) =>
              typeof x?.name === 'string' &&
              Array.isArray(x.patch?.eqDb) &&
              x.patch.eqDb.length === 10
          )
        : []
    } catch {
      return []
    }
  })
  const [name, setName] = useState('')
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between rounded-2xl bg-hover p-3">
        <div>
          <p className="text-sm font-semibold">音频工作室</p>
          <p className="mt-1 text-xs text-fg-muted">64 位处理 · 平滑切换 · 立体声联动限幅</p>
        </div>
        <Toggle
          label="启用 DSP"
          checked={config.enabled}
          disabled={dsd}
          onChange={(enabled) => update({ enabled })}
        />
      </div>
      {dsd && (
        <p className="text-xs text-fg-muted">
          DSD 直通绕过音效。切换输出中的 DSD → PCM 后可启用 DSP。
        </p>
      )}
      <label className="flex items-center justify-between gap-3 text-xs text-fg-muted">
        音效预置
        <Select
          aria-label="音效预置"
          defaultValue=""
          disabled={dsd}
          onChange={(e) => {
            const preset = [...DSP_PRESETS, ...custom].find((p) => p.name === e.target.value)
            if (preset) update({ ...preset.patch, enabled: true })
            e.target.value = ''
          }}
          className="rounded-xl bg-hover p-2 text-fg"
        >
          <option value="" disabled>
            选择预置
          </option>
          {[...DSP_PRESETS, ...custom].map((p) => (
            <option key={p.name}>{p.name}</option>
          ))}
        </Select>
      </label>
      <fieldset disabled={dsd} className="min-w-0 space-y-4 disabled:opacity-50">
        <legend className="text-xs font-medium text-fg-subtle">10 段均衡器 · ±12 dB</legend>
        <svg
          viewBox="0 0 460 96"
          role="img"
          aria-label="均衡器频率响应"
          className="w-full rounded-xl bg-black/15"
        >
          {[16, 48, 80].map((y) => (
            <path key={y} d={`M0,${y}H460`} stroke="currentColor" className="text-fg-muted/15" />
          ))}
          <path
            d={response(config.eqDb, rate > 1e6 ? rate / 64 : rate)}
            fill="none"
            stroke="rgb(var(--accent))"
            strokeWidth="2"
          />
        </svg>
        <div className="grid grid-cols-10 gap-2">
          {EQ_HZ.map((hz, i) => (
            <label key={hz} className="flex flex-col items-center gap-2 text-[10px] text-fg-muted">
              <output className="font-mono text-fg">{config.eqDb[i]!.toFixed(1)}</output>
              <Range
                aria-label={`EQ ${hz} Hz`}
                min={-12}
                max={12}
                step={0.5}
                value={config.eqDb[i]}
                vertical
                style={{ height: 112, width: 32 }}
                className="accent-[rgb(var(--accent))]"
                onChange={(e) => {
                  const eqDb: DspConfig['eqDb'] = [...config.eqDb]
                  eqDb[i] = Number(e.target.value)
                  update({ eqDb })
                }}
              />
              <span>{hz >= 1000 ? `${hz / 1000}k` : Math.round(hz)}</span>
            </label>
          ))}
        </div>
        <Slider
          label="前级增益"
          value={config.preampDb}
          min={-24}
          max={12}
          unit=" dB"
          onChange={(preampDb) => update({ preampDb })}
        />
        <Slider
          label="声道平衡（左 ↔ 右）"
          value={config.balance}
          min={-1}
          max={1}
          step={0.01}
          onChange={(balance) => update({ balance })}
        />
        <Slider
          label="立体声宽度"
          value={config.stereoWidth * 100}
          min={0}
          max={200}
          step={1}
          unit="%"
          onChange={(v) => update({ stereoWidth: v / 100 })}
        />
        <Slider
          label="耳机交叉馈送"
          value={config.crossfeed * 100}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={(v) => update({ crossfeed: v / 100 })}
        />
        <div className="flex items-center justify-between gap-3 text-xs text-fg-muted">
          <span>峰值保护（−0.18 dBFS，80 ms 释放）</span>
          <Toggle
            label="峰值保护"
            checked={config.limiter}
            onChange={(limiter) => update({ limiter })}
          />
        </div>
      </fieldset>
      <div className="flex gap-2">
        <input
          aria-label="自定义预置名称"
          placeholder="保存当前音效为…"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-xl bg-hover p-2 text-xs"
        />
        <button
          type="button"
          disabled={!name.trim() || DSP_PRESETS.some((p) => p.name === name.trim())}
          className="rounded-xl bg-hover px-3 text-xs disabled:opacity-40"
          onClick={() => {
            const next = [
              ...custom.filter((p) => p.name !== name.trim()),
              { name: name.trim(), patch: config },
            ].slice(-20)
            setCustom(next)
            localStorage.setItem('jap.dsp.presets', JSON.stringify(next))
            setName('')
          }}
        >
          保存
        </button>
        <button
          type="button"
          className="rounded-xl bg-hover px-3 text-xs"
          onClick={() => update(DEFAULT_DSP)}
        >
          重置
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-fg-muted">
        启用后信号链标记为“已处理”。更改约在 0.5 秒缓冲后生效；提升频段时建议保留前级余量。
      </p>
    </div>
  )
}
