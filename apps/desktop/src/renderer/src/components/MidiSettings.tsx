import { useState } from 'react'
import { useSettings } from '../settings/store'
import { SectionTitle, SettingRow } from '../ui/controls'
import { Select } from '../ui/Select'
import { baseName } from '@shared/audio'
export function MidiSettings(): React.JSX.Element {
  const path = useSettings((s) => s.midiSoundfont)
  const rate = useSettings((s) => s.midiSampleRate)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const choose = async (): Promise<void> => {
    setPending(true)
    setError('')
    try {
      const path = await window.jap.importSoundfont()
      if (path) useSettings.getState().update({ midiSoundfont: path })
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>MIDI 音色与合成</SectionTitle>
      <SettingRow
        title={
          path
            ? baseName(path)
            : window.jap.bundledMidi
              ? 'MuseScore General HQ · 无损 SF2'
              : '尚未导入音色库'
        }
        hint={
          window.jap.bundledMidi || path
            ? '完整 GM 乐器与鼓组，512 复音、7 阶插值、立体声浮点合成。切换音色后，下次播放 MIDI 时生效。'
            : '此为 without-midi 轻量包。导入 SF2 后即可播放 MIDI，其他音频功能可直接使用。'
        }
      >
        <button
          type="button"
          disabled={pending}
          onClick={() => void choose()}
          className="rounded-xl bg-hover px-3 py-2 text-xs text-accent-text"
        >
          {pending ? '正在导入…' : '导入 SF2 音色库'}
        </button>
      </SettingRow>
      {path && (
        <button
          type="button"
          onClick={() => useSettings.getState().update({ midiSoundfont: '' })}
          className="self-start text-xs text-accent-text"
        >
          {window.jap.bundledMidi ? '恢复内置 HQ 音色' : '清除自定义音色'}
        </button>
      )}
      <SettingRow
        title="合成采样率"
        hint="这是 MIDI 实时合成的输出格式；MIDI 本身没有录音位深或原始采样率。最终硬件格式见解码卡片。"
      >
        <Select
          aria-label="MIDI 合成采样率"
          value={rate}
          onChange={(e) =>
            useSettings.getState().update({ midiSampleRate: Number(e.target.value) })
          }
          className="rounded-lg bg-hover p-2 text-xs"
        >
          {[44100, 48000, 96000].map((v) => (
            <option key={v} value={v}>
              {v / 1000} kHz · Float32
            </option>
          ))}
        </Select>
      </SettingRow>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  )
}
