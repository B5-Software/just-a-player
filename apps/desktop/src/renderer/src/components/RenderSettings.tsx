import { useEffect, useState } from 'react'
import type { GpuInfo } from '@shared/gpu'
import { useSettings } from '../settings/store'
import { useHdr } from '../viz/hdr'
import { SectionTitle, SettingRow, Toggle } from '../ui/controls'
export function RenderSettings(): React.JSX.Element {
  const [gpu, setGpu] = useState<GpuInfo | null>(null)
  const selected = useSettings((s) => s.renderGpu),
    enabled = useSettings((s) => s.hdrEnabled)
  const hdr = useHdr()
  useEffect(() => {
    let alive = true
    void window.jap.gpuInfo().then((v) => {
      if (alive) setGpu(v)
    })
    return () => {
      alive = false
    }
  }, [])
  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>渲染设备与 HDR</SectionTitle>
      <SettingRow title="渲染 GPU" hint="主窗口、桌面壁纸和后台导出共用所选 GPU，重启后生效。">
        <select
          aria-label="渲染 GPU"
          value={selected}
          onChange={(e) => useSettings.getState().update({ renderGpu: e.target.value })}
          className="max-w-44 rounded-lg bg-hover p-2 text-xs"
        >
          <option value="auto">系统自动选择</option>
          {gpu && selected !== 'auto' && !gpu.adapters.some((g) => g.id === selected) && (
            <option value={selected} disabled>
              所选 GPU 已离线 · 当前自动选择
            </option>
          )}
          {gpu?.adapters.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
              {Number(g.id.split(':').at(-1)) > 0
                ? ` · 设备 ${Number(g.id.split(':').at(-1)) + 1}`
                : ''}
              {g.memoryMb
                ? g.memoryMb >= 1024
                  ? ` · ${(g.memoryMb / 1024).toFixed(1)} GB`
                  : ` · ${g.memoryMb} MB`
                : ''}
            </option>
          ))}
        </select>
      </SettingRow>
      <p className="break-words text-[11px] leading-5 text-fg-muted">
        当前：{gpu?.current ?? '正在读取…'}
        {gpu?.error ? ` · ${gpu.error}` : ''}
      </p>
      {gpu &&
        selected !== gpu.selected &&
        (selected === 'auto' || gpu.adapters.some((g) => g.id === selected)) && (
          <button
            type="button"
            onClick={() => {
              void window.jap.restart()
            }}
            className="rounded-xl bg-accent p-2 text-xs text-on-accent"
          >
            重启并应用 GPU
          </button>
        )}
      <SettingRow title="HDR 输出" hint={hdr.reason}>
        <Toggle
          label="HDR 输出"
          checked={enabled}
          disabled={!hdr.supported && !enabled}
          onChange={(hdrEnabled) => useSettings.getState().update({ hdrEnabled })}
        />
      </SettingRow>
      <p className="text-[11px] leading-5 text-fg-muted">
        默认关闭。显示器或系统不支持时自动使用 SDR；视频导出目前使用 SDR。
      </p>
    </section>
  )
}
