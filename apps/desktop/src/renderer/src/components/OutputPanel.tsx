import { Select } from '../ui/Select'
import { useEffect, useState } from 'react'
import { engine } from '../engine/client'
import type { OutputApi } from '@shared/protocol/OutputApi'
import type { StreamConfig } from '@shared/protocol/StreamConfig'
import { usePlayer } from '../engine/store'
import { Segmented, type SegmentOption } from './Segmented'

const API_OPTIONS: readonly SegmentOption<OutputApi>[] =
  window.jap.platform === 'ohos'
    ? [
        { value: 'ohosShared', label: 'OHAudio' },
        { value: 'usbExclusive', label: 'USB 独占' },
      ]
    : window.jap.platform === 'android'
      ? [
          { value: 'androidShared', label: '系统音频' },
          { value: 'usbExclusive', label: 'USB 独占' },
        ]
      : window.jap.platform === 'darwin'
        ? [
            { value: 'coreAudio', label: 'CoreAudio' },
            { value: 'coreAudioExclusive', label: 'Hog 独占' },
          ]
        : window.jap.platform === 'linux'
          ? [
              { value: 'alsaShared', label: '系统共享' },
              { value: 'alsaExclusive', label: 'ALSA 硬件直出' },
            ]
          : [
              { value: 'wasapiShared', label: '共享' },
              { value: 'wasapiExclusive', label: '独占' },
              { value: 'asio', label: 'ASIO' },
            ]

const BUFFER_CHOICES = [10, 20, 40, 80] as const

/** 输出设置（浮层内容）。 */
export function OutputPanel(): React.JSX.Element {
  const output = usePlayer((s) => s.output)
  const devices = usePlayer((s) => s.devices)
  const setOutput = usePlayer((s) => s.setOutput)

  const api = output.api
  const shared = [
    'wasapiShared',
    'coreAudio',
    'alsaShared',
    'androidShared',
    'ohosShared',
  ].includes(api)
  const [probe, setProbe] = useState('')
  const [probing, setProbing] = useState(false)
  const [usbStatus, setUsbStatus] = useState('')
  const [formats, setFormats] = useState<StreamConfig[]>([])
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true
    setFormats([])
    setProbe('')
    setProbing(true)
    const timer = setTimeout(
      () =>
        void engine
          .query({ type: 'deviceFormats', api, deviceId: output.deviceId })
          .then((r) => {
            if (!alive) return
            if (r.type === 'exclusiveFormats') setFormats(r.formats)
            else setProbe(r.type === 'error' ? r.message : '无法读取设备格式')
          })
          .catch((e) => {
            if (alive) setProbe(String(e))
          })
          .finally(() => {
            if (alive) setProbing(false)
          }),
      150
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, output.deviceId, revision])
  useEffect(
    () =>
      window.jap.onUsbChange?.(() => {
        void usePlayer.getState().refreshDevices()
      }),
    []
  )

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
              ...([
                'wasapiShared',
                'coreAudio',
                'alsaShared',
                'androidShared',
                'ohosShared',
              ].includes(value)
                ? { dsdMode: 'pcm' }
                : {}),
            })
          }
        />
        <p className="text-xs leading-relaxed text-fg-muted">
          {api === 'usbExclusive'
            ? window.jap.platform === 'ohos'
              ? '通过 HarmonyOS USB Host 的授权句柄直接认领 DAC，按设备描述符与时钟协商，绕过系统混音器。'
              : '通过 Android USB Host 直接认领 DAC，按设备真实格式和时钟协商，绕过 AudioFlinger。需 OTG 连接并授权 USB 访问。'
            : api === 'ohosShared'
              ? 'HarmonyOS 原生 OHAudio；系统共享链路不保证 bit-perfect。USB 独占通过授权设备句柄直接传输到 DAC。'
              : api === 'androidShared'
                ? 'AAudio 系统共享，可使用内置扬声器、耳机和蓝牙；系统可能重采样。USB 位流直通请选择 USB 独占。'
                : api === 'coreAudioExclusive'
                  ? 'CoreAudio Hog：独占 DAC，优先按源格式输出；设备不接受时自动适配并标记非 bit-perfect。'
                  : api === 'coreAudio'
                    ? 'CoreAudio：自动切换设备采样率，支持系统共享；共享链路不宣称比特完美。'
                    : api === 'alsaExclusive'
                      ? 'ALSA hw：直接打开硬件并验证实际采样率、格式和声道，不经过 plughw/dmix。设备被声音服务器占用时可切换系统共享。'
                      : api === 'alsaShared'
                        ? '通过 ALSA 的系统默认插件接入 PipeWire / PulseAudio，可与其他应用同时播放；系统可能重采样。'
                        : api === 'asio'
                          ? 'ASIO：直接使用已安装的 64 位驱动。原生 DSD 需要驱动明确支持；ASIO4ALL 不能替代厂商的原生 DSD 驱动。'
                          : api === 'wasapiExclusive'
                            ? '独占：绕过 Windows 混音器。原格式优先，设备不接受时自动适配并标记非 bit-perfect。'
                            : '共享：由 Windows 混音，可与其他程序同时发声，但不是比特完美。'}
        </p>
      </div>

      {api === 'usbExclusive' && (
        <div className="rounded-2xl bg-accent/8 p-3">
          <button
            type="button"
            className="rounded-xl bg-accent px-4 py-2 text-sm text-on-accent"
            onClick={async () => {
              try {
                setUsbStatus(await window.jap.connectUsb!())
                await usePlayer.getState().refreshDevices()
              } catch (e) {
                setUsbStatus(String(e))
              }
            }}
          >
            连接 USB DAC
          </button>
          {usbStatus && (
            <p role="status" className="mt-2 text-xs text-fg-muted">
              {usbStatus}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor="device" className="text-xs font-medium text-fg-subtle">
          设备
        </label>
        <div className="p-0.5">
          <Select
            id="device"
            value={output.deviceId ?? ''}
            onChange={(e) => setOutput({ deviceId: e.target.value || null })}
            className="w-full rounded-xl bg-hover px-3 py-2 text-sm text-fg outline-none ring-1 ring-line focus:ring-accent"
          >
            <option value="">
              {api === 'asio'
                ? '首个已安装的 ASIO 驱动'
                : api === 'alsaExclusive'
                  ? '首个可用 ALSA 硬件设备'
                  : '系统默认设备'}
            </option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.isDefault ? '（默认）' : ''}
              </option>
            ))}
          </Select>
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
        <Select
          id="dsd-mode"
          value={output.dsdMode}
          onChange={(e) => setOutput({ dsdMode: e.target.value as typeof output.dsdMode })}
          className="rounded-xl bg-hover p-2 text-sm"
        >
          <option value="pcm">DSD → PCM（可使用 DSP）</option>
          <option value="dop" disabled={shared}>
            DoP 1.1 · DSD 位流直通
          </option>
          <option value="native" disabled={api !== 'asio' && api !== 'usbExclusive'}>
            {api === 'usbExclusive' ? 'USB RAW_DATA · 原生 DSD' : 'ASIO Native · 原生 DSD'}
          </option>
        </Select>
        <p className="text-xs leading-relaxed text-fg-muted">
          DoP 所需载波：DSD64 → 176.4 kHz；DSD128 → 352.8 kHz；DSD256 → 705.6
          kHz。设备必须同时支持对应载波和 DoP 识别；不支持时明确报错。直通时关闭 DSP。
        </p>
      </div>
      {
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={probing}
            className="self-start text-xs text-accent-text"
            onClick={async () => {
              setRevision((v) => v + 1)
            }}
          >
            {probing ? '检测中…' : '重新检测设备格式'}
          </button>
          {probe && <p className="text-[11px] leading-relaxed text-fg-muted">{probe}</p>}
          {!!formats.length && (
            <div className="max-h-56 overflow-auto rounded-xl ring-1 ring-line">
              <table className="w-full text-left text-xs" aria-label="设备支持格式">
                <thead className="sticky top-0 bg-panel">
                  <tr>
                    <th className="p-2">采样率</th>
                    <th className="p-2">位深／编码</th>
                    <th className="p-2">声道</th>
                  </tr>
                </thead>
                <tbody>
                  {[...new Set(formats.map((f) => f.sampleRate))]
                    .sort((a, b) => a - b)
                    .map((rate) => (
                      <tr key={rate} className="border-t border-line">
                        <td className="p-2 tabular-nums">{rate / 1000} kHz</td>
                        <td className="p-2">
                          {[
                            ...new Set(
                              formats
                                .filter((f) => f.sampleRate === rate)
                                .map(
                                  (f) =>
                                    ({
                                      i16: '16-bit',
                                      i24Packed: '24-bit',
                                      i24In32: '24-in-32',
                                      i32: '32-bit',
                                      f32: '32-bit float',
                                      f64: '64-bit float',
                                      dop24: 'DoP24',
                                      dop32: 'DoP32',
                                      dsdU8Lsb: 'DSD LSB',
                                      dsdU8Msb: 'DSD MSB',
                                    })[f.format]
                                )
                            ),
                          ].join(' / ')}
                        </td>
                        <td className="p-2">
                          {[
                            ...new Set(
                              formats.filter((f) => f.sampleRate === rate).map((f) => f.channels)
                            ),
                          ].join(' / ')}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-fg-muted">
            {shared
              ? '表格显示系统流或驱动报告的可用格式；共享模式不保证 bit-perfect。'
              : '表格来自设备描述符或驱动查询；DoP 载波支持不代表设备一定能识别 DoP。'}{' '}
            原格式优先；设备不接受时自动适配采样率、位深，信号链标记为非 bit-perfect。
          </p>
        </div>
      }
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
