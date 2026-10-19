import { useState } from 'react'
import { engine } from '../engine/client'
import type { OutputApi } from '@shared/protocol/OutputApi'
import { usePlayer } from '../engine/store'
import { Segmented, type SegmentOption } from './Segmented'

const API_OPTIONS: readonly SegmentOption<OutputApi>[] =
  window.jap.platform === 'darwin'
    ? [
        { value: 'coreAudio', label: 'CoreAudio' },
        { value: 'coreAudioExclusive', label: 'Hog 独占' }
      ]
    : window.jap.platform === 'linux'
      ? [
          { value: 'alsaShared', label: '系统共享' },
          { value: 'alsaExclusive', label: 'ALSA 硬件直出' }
        ]
      : [
          { value: 'wasapiShared', label: '共享' },
          { value: 'wasapiExclusive', label: '独占' },
          { value: 'asio', label: 'ASIO' }
        ]

const BUFFER_CHOICES = [10, 20, 40, 80] as const

/** 输出设置（浮层内容）。 */
export function OutputPanel(): React.JSX.Element {
  const output = usePlayer((s) => s.output)
  const devices = usePlayer((s) => s.devices)
  const setOutput = usePlayer((s) => s.setOutput)

  const api = output.api
  const shared = ['wasapiShared', 'coreAudio', 'alsaShared'].includes(api)
  const [probe, setProbe] = useState('')
  const [probing, setProbing] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={() => usePlayer.getState().resetBuffer()}
        className="rounded-xl bg-hover px-3 py-2 text-sm text-fg"
      >
        重置音频缓冲
      </button>
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-fg-subtle">模式</label>
        <Segmented
          aria-label="输出模式"
          value={api}
          options={API_OPTIONS}
          onChange={(value) =>
            setOutput({
              api: value,
              ...(['wasapiShared', 'coreAudio', 'alsaShared'].includes(value)
                ? { dsdMode: 'pcm' }
                : {})
            })
          }
        />
        <p className="text-xs leading-relaxed text-fg-muted">
          {api === 'coreAudioExclusive'
            ? 'CoreAudio Hog：独占 DAC，按源采样率协商，并验证硬件物理位深与格式；不满足时明确报错。'
            : api === 'coreAudio'
              ? 'CoreAudio：自动切换设备采样率，支持系统共享；共享链路不宣称比特完美。'
              : api === 'alsaExclusive'
                ? 'ALSA hw：直接打开硬件并验证实际采样率、格式和声道，不经过 plughw/dmix。设备被声音服务器占用时可切换系统共享。'
                : api === 'alsaShared'
                  ? '通过 ALSA 的系统默认插件接入 PipeWire / PulseAudio，可与其他应用同时播放；系统可能重采样。'
                  : api === 'asio'
                    ? 'ASIO：直接使用已安装的 64 位驱动。原生 DSD 需要驱动明确支持；ASIO4ALL 不能替代厂商的原生 DSD 驱动。'
                    : api === 'wasapiExclusive'
                      ? '独占：绕过 Windows 混音器，按文件原始格式直送设备。'
                      : '共享：由 Windows 混音，可与其他程序同时发声，但不是比特完美。'}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="device" className="text-xs font-medium text-fg-subtle">
          设备
        </label>
        <div className="p-0.5">
          <select
            id="device"
            value={output.deviceId ?? ''}
            onChange={(e) => setOutput({ deviceId: e.target.value || null })}
            className="w-full rounded-xl bg-hover px-3 py-2 text-sm text-fg outline-none ring-1 ring-line focus:ring-accent"
          >
            <option value="">{api === 'asio' ? '首个已安装的 ASIO 驱动' : api === 'alsaExclusive' ? '首个可用 ALSA 硬件设备' : '系统默认设备'}</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.isDefault ? '（默认）' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {api === 'asio' && devices.length === 0 && (
        <p role="status" className="text-xs text-fg-muted">
          没有发现 64 位 ASIO 驱动。安装后点击刷新设备。
        </p>
      )}
      <button
        type="button"
        className="self-start text-xs text-accent-text"
        onClick={() => void usePlayer.getState().refreshDevices()}
      >
        刷新设备
      </button>
      <div className="flex flex-col gap-2">
        <label htmlFor="dsd-mode" className="text-xs font-medium text-fg-subtle">
          DSD 播放方式
        </label>
        <select
          id="dsd-mode"
          value={output.dsdMode}
          onChange={(e) => setOutput({ dsdMode: e.target.value as typeof output.dsdMode })}
          className="rounded-xl bg-hover p-2 text-sm"
        >
          <option value="pcm">DSD → PCM（可使用 DSP）</option>
          <option value="dop" disabled={shared}>
            DoP 1.1 · DSD 位流直通
          </option>
          <option value="native" disabled={api !== 'asio'}>
            ASIO Native · 原生 DSD
          </option>
        </select>
        <p className="text-xs leading-relaxed text-fg-muted">
          DoP 所需载波：DSD64 → 176.4 kHz；DSD128 → 352.8 kHz；DSD256 → 705.6
          kHz。设备必须同时支持对应载波和 DoP 识别；不支持时明确报错。直通时关闭 DSP。
        </p>
      </div>
      {api !== 'asio' && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={probing}
            className="self-start text-xs text-accent-text"
            onClick={async () => {
              setProbing(true)
              try {
                const r = await engine.query({ type: 'probeExclusive', deviceId: output.deviceId })
                setProbe(
                  r.type === 'exclusiveFormats'
                    ? [...new Set(r.formats.map((f) => `${f.sampleRate / 1000} kHz`))].join(
                        ' · '
                      ) || '设备未报告可用格式'
                    : r.type === 'error'
                      ? r.message
                      : '无法读取格式'
                )
              } finally {
                setProbing(false)
              }
            }}
          >
            {probing ? '检测中…' : '检测设备独占 PCM 格式'}
          </button>
          {probe && <p className="text-[11px] leading-relaxed text-fg-muted">{probe}</p>}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-fg-subtle">
          {api === 'asio' ? '缓冲由 ASIO 驱动决定' : '缓冲'}
        </label>
        {api !== 'asio' && (
          <Segmented
            aria-label="缓冲时长"
            size="sm"
            value={String(output.bufferMs)}
            options={BUFFER_CHOICES.map((ms) => ({ value: String(ms), label: `${ms} ms` }))}
            onChange={(value) => setOutput({ bufferMs: Number(value) })}
          />
        )}
      </div>
    </div>
  )
}
