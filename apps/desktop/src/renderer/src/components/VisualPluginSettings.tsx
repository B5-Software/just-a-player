import { useState } from 'react'
import { parseVisualPlugin } from '@shared/visual-plugin'
import { LEGACY_VISUALS } from '@shared/visual-builtins'
import { STUDIO_PLUGINS } from '../viz/plugins/studio'
import { checkShader } from '../viz/plugins/shader'
import { useSceneRegistry } from '../viz/scenes'
import { useSettings } from '../settings/store'
import { useViz } from '../viz/store'
import { SectionTitle, SettingRow, Toggle } from '../ui/controls'
import { confirmAction } from '../ui/dialog-store'
export function VisualPluginSettings(): React.JSX.Element {
  const legacy = useSettings((s) => s.enabledLegacyVisuals),
    disabled = useSettings((s) => s.disabledVisuals),
    plugins = useSettings((s) => s.visualPlugins)
  const loading = useSceneRegistry((s) => s.loading),
    registryError = useSceneRegistry((s) => s.error)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const toggle = (id: string, on: boolean): void =>
    useSettings
      .getState()
      .update({ disabledVisuals: on ? disabled.filter((x) => x !== id) : [...disabled, id] })
  const install = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const [path] = await window.jap.openVisualPluginFiles()
      if (!path) return
      const data = await window.jap.readFile(path)
      if (!data || data.length > 65536) throw Error('插件文件为空或超过 64 KiB')
      const plugin = parseVisualPlugin(JSON.parse(new TextDecoder().decode(data)))
      checkShader(plugin)
      if (
        !(await confirmAction(
          `安装「${plugin.name}」？`,
          `${plugin.author} · ${plugin.license}\n${plugin.description}\n这是图形着色器插件，不执行 JavaScript。`,
          '安装插件'
        ))
      )
        return
      const current = useSettings.getState()
      if (
        current.visualPlugins.length >= 16 &&
        !current.visualPlugins.some((p) => p.id === plugin.id)
      )
        throw Error('最多安装 16 个外部插件')
      current.update({
        visualPlugins: [...current.visualPlugins.filter((p) => p.id !== plugin.id), plugin],
        disabledVisuals: current.disabledVisuals.filter((id) => id !== 'user-' + plugin.id),
      })
      useViz.getState().setScene('user-' + plugin.id)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="flex flex-col gap-4" data-visual-plugins>
      <SectionTitle>可视化插件</SectionTitle>
      <p className="text-xs leading-relaxed text-fg-muted">
        每个效果可独立启用或卸下。新的材质场景共用实时、HDR
        与离线导出定义；全部关闭时保留封面与歌词。
      </p>
      {STUDIO_PLUGINS.map((plugin) => (
        <SettingRow key={plugin.id} title={plugin.name} hint={plugin.description}>
          <Toggle
            label={`启用 ${plugin.name}`}
            checked={!disabled.includes(plugin.id)}
            onChange={(on) => toggle(plugin.id, on)}
          />
        </SettingRow>
      ))}
      <div className="rounded-2xl bg-hover/50 p-4">
        <p className="mb-3 text-xs text-fg-muted">附加场景与专业仪表 · 默认关闭，逐项启用</p>
        <div className="flex flex-col gap-4">
          {LEGACY_VISUALS.map((plugin) => (
            <SettingRow key={plugin.id} title={plugin.name} hint={plugin.hint}>
              <Toggle
                label={`启用 ${plugin.name}`}
                checked={legacy.includes(plugin.id)}
                onChange={(on) =>
                  useSettings
                    .getState()
                    .update({
                      enabledLegacyVisuals: on
                        ? [...legacy, plugin.id]
                        : legacy.filter((id) => id !== plugin.id),
                    })
                }
              />
            </SettingRow>
          ))}
        </div>
        {loading && <p className="mt-2 text-xs text-fg-muted">正在加载旧版插件…</p>}
      </div>
      {plugins.map((plugin) => (
        <div key={plugin.id} className="rounded-2xl bg-hover/40 p-3">
          <SettingRow title={plugin.name} hint={`${plugin.author} · ${plugin.license}`}>
            <Toggle
              label={`启用 ${plugin.name}`}
              checked={!disabled.includes('user-' + plugin.id)}
              onChange={(on) => toggle('user-' + plugin.id, on)}
            />
          </SettingRow>
          <button
            className="mt-2 text-xs text-fg-muted hover:text-accent-text"
            onClick={() =>
              useSettings
                .getState()
                .update({ visualPlugins: plugins.filter((p) => p.id !== plugin.id) })
            }
          >
            卸下插件
          </button>
        </div>
      ))}
      <button
        className="rounded-xl bg-hover px-4 py-3 text-sm text-accent-text disabled:opacity-40"
        disabled={busy}
        onClick={() => void install()}
      >
        {busy ? '正在检查…' : '导入效果插件 · JSON / GLSL'}
      </button>
      {(error || registryError) && (
        <p role="alert" className="text-xs text-red-400">
          {error || registryError}
        </p>
      )}
    </section>
  )
}
