import { useEffect, useState } from 'react'
import type { LightingStatus } from '@shared/lighting'
import { useSettings } from '../settings/store'
import { SectionTitle, SettingRow, Slider, Toggle } from '../ui/controls'
export function LightingSettings(): React.JSX.Element {
  const enabled = useSettings((s) => s.argbEnabled),
    brightness = useSettings((s) => s.argbBrightness),
    port = useSettings((s) => s.argbPort),
    selected = useSettings((s) => s.argbDevices),
    update = useSettings((s) => s.update)
  const [status, setStatus] = useState<LightingStatus>({
    connected: false,
    message: '',
    devices: []
  })
  useEffect(() => {
    let active = true
    const poll = (): void => {
      void window.jap.lightingStatus().then((s) => {
        if (active) setStatus(s)
      })
    }
    poll()
    const timer = setInterval(poll, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [enabled, port])
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>ARGB 灯光</SectionTitle>
      <SettingRow
        title="灯光跟随强调色"
        hint="通过本地 OpenRGB SDK 联动设备，自动取色与手动强调色均支持。关闭后恢复接入前的灯光。"
      >
        <Toggle
          label="ARGB 灯光联动"
          checked={enabled}
          onChange={(argbEnabled) => update({ argbEnabled })}
        />
      </SettingRow>
      {enabled && (
        <>
          <SettingRow title="OpenRGB SDK 端口">
            <input
              aria-label="OpenRGB SDK 端口"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) =>
                update({
                  argbPort: Math.max(1, Math.min(65535, Math.round(Number(e.target.value))))
                })
              }
              className="w-24 rounded-xl bg-hover p-2 text-xs"
            />
          </SettingRow>
          <Slider
            label="灯光亮度"
            value={brightness}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(argbBrightness) => update({ argbBrightness })}
          />
          <p role="status" className="text-xs text-fg-muted">
            {status.message}
          </p>
          <SettingRow title="全部设备">
            <Toggle
              label="全部灯光设备"
              checked={selected.includes('*')}
              onChange={(all) => update({ argbDevices: all ? ['*'] : [] })}
            />
          </SettingRow>
          {status.devices.map((d) => (
            <SettingRow key={d.key} title={d.name} hint={`${d.leds} 个灯珠`}>
              <Toggle
                label={`联动 ${d.name}`}
                checked={selected.includes('*') || selected.includes(d.key)}
                onChange={(on) =>
                  update({
                    argbDevices: on
                      ? [...new Set([...selected, d.key])]
                      : (selected.includes('*')
                          ? status.devices.map((d) => d.key)
                          : selected
                        ).filter((key) => key !== d.key)
                  })
                }
              />
            </SettingRow>
          ))}
        </>
      )}
    </section>
  )
}
