import { useState } from 'react'
import { SectionTitle, SettingRow, Toggle } from '../ui/controls'
import { useExternal } from '../external/store'
import { engine } from '../engine/client'
import { usePlayer } from '../engine/store'

export function ExternalPlayerSettings(): React.JSX.Element | null {
  const state = useExternal()
  const [busy, setBusy] = useState(false)
  const [force, setForce] = useState(() => localStorage.getItem('jap.external.force') === '1')
  if (window.jap.platform !== 'win32') return null
  const connected = state.phase === 'ready' || state.phase === 'routing'
  const run = async (action: 'connect' | 'disconnect' | 'route'): Promise<void> => {
    setBusy(true)
    try { await engine.external(action, undefined, force) }
    catch (error) { usePlayer.setState({ error: String(error) }) }
    finally { setBusy(false) }
  }
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-hover/40 p-4">
      <SectionTitle>外部播放器 · 网易云音乐</SectionTitle>
      <SettingRow title="连接客户端" hint="添加专用黑洞设备；原始音频、歌词、封面和控制通过本机通路同步。">
        <Toggle label="连接网易云音乐" checked={connected || state.phase === 'connecting'} disabled={busy} onChange={on => { void run(on ? 'connect' : 'disconnect') }} />
      </SettingRow>
      <SettingRow title="强制接管" hint="跳过客户端版本白名单，尝试适配模块编号变化及更多 PCM 格式；仍检查数据长度、时间戳与内存边界。">
        <Toggle label="强制接管" checked={force} disabled={connected || busy} onChange={value => { setForce(value); localStorage.setItem('jap.external.force', value ? '1' : '0') }} />
      </SettingRow>
      {connected && (
        <>
          <p className="text-xs leading-relaxed text-fg-muted">在网易云输出设备中选择 <span className="text-accent-text">Just A Player HiFi Bridge (Black Hole)</span>，客户端最终输出会直接丢弃，DAC 交给本播放器。也可在下方直接切换。</p>
          {state.phase === 'ready' && <button type="button" disabled={busy || !state.snapshot?.devices} className="rounded-xl bg-accent px-4 py-2 text-sm text-on-accent disabled:opacity-50" onClick={() => { void run('route') }}>切换客户端到黑洞设备</button>}
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-panel/60 p-3 text-xs">
            <div><span className="text-fg-muted">接收音频包</span><p className="mt-1 font-mono">{state.audioPackets.toLocaleString()}</p></div>
            <div><span className="text-fg-muted">黑洞已丢弃</span><p className="mt-1 font-mono">{(Number(state.nullBytes) / 1048576).toFixed(1)} MiB</p></div>
          </div>
          <p className="text-[11px] leading-relaxed text-fg-muted">虚拟设备仅出现在已连接的客户端内。FLAC 优先转交原始压缩包；其他编码可接收客户端音效处理前的 PCM。实际通路和 Bit-Perfect 状态见信号链。</p>
        </>
      )}
      {state.message && <p role="status" className="text-xs leading-relaxed text-accent-text">{state.message}</p>}
    </section>
  )
}
