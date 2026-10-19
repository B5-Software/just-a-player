import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { useUi } from '../ui/store'
import { useSettings } from '../settings/store'
import { useViz } from '../viz/store'
import { Slider } from '../ui/controls'
import { X } from '../icons'

export function Onboarding(): React.JSX.Element | null {
  const open = useUi((s) => s.onboardingOpen)
  const [step, setStep] = useState(0)
  const rotation = useSettings((s) => s.lyricsRotation)
  useEffect(() => {
    if (!open) {
      setStep(0)
      return
    }
    useUi.getState().setLyricsAdjusting(step > 0)
    useUi.setState({ lyricsPreview: true })
    useSettings.getState().update({ lyricsMode: '3d', lyricsVisible: true })
    if (step === 2) useSettings.getState().update({ lyricsPose: 'free' })
    return () => useUi.setState({ lyricsAdjusting: false, lyricsPreview: false })
  }, [open, step])
  if (!open) return null
  const finish = (): void => {
    useUi.getState().setOnboardingOpen(false)
    useSettings.getState().update({ onboardingComplete: true })
  }
  return (
    <motion.aside
      data-onboarding
      role="dialog"
      aria-label="舞台新手指导"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className={`glass absolute top-28 z-40 w-80 rounded-3xl p-5 ${step > 0 ? 'left-6' : 'right-6'}`}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold tracking-widest text-accent-text">
          布置你的音乐舞台 · {step + 1}/3
        </p>
        <button
          aria-label="稍后再说"
          type="button"
          onClick={finish}
          className="rounded-lg p-1 text-fg-muted hover:bg-hover"
        >
          <X size={16} />
        </button>
      </div>
      <h2 className="mt-3 text-lg font-semibold">
        {['移动可视化', '单独移动 3D 歌词', '旋转歌词'][step]}
      </h2>
      <p className="mt-2 text-xs leading-6 text-fg-muted">
        {
          [
            '在舞台空白处拖动可视化，用滚轮缩放，双击恢复位置。位置与缩放会自动保存。示波器等仪表始终铺满画面。',
            '已显示测试歌词，无需先播放歌曲。按住歌词拖动，松开即停止；这一步不会移动可视化。位置会自动保存，结束指导后恢复歌曲歌词。',
            '分别调整三个方向，找到舒服的观看角度。字体、字号、位置与旋转都会自动保存，下次打开继续使用。'
          ][step]
        }
      </p>
      {step === 0 && (
        <button
          type="button"
          onClick={() => useViz.getState().resetPosition()}
          className="mt-3 rounded-xl bg-hover px-3 py-2 text-xs"
        >
          恢复可视化位置
        </button>
      )}
      {step === 2 && (
        <div className="mt-4 space-y-3">
          {(['x', 'y', 'z'] as const).map((axis, i) => (
            <label key={axis} className="block text-xs text-fg-muted">
              {['俯仰', '左右转向', '平面旋转'][i]}
              <Slider
                label={`指导旋转 ${axis.toUpperCase()}`}
                value={rotation[axis]}
                min={-180}
                max={180}
                step={1}
                onChange={(value) =>
                  useSettings.getState().update({
                    lyricsRotation: { ...useSettings.getState().lyricsRotation, [axis]: value }
                  })
                }
                format={(v) => `${v}°`}
              />
            </label>
          ))}
        </div>
      )}
      <div className="mt-5 flex items-center justify-between">
        <button
          type="button"
          onClick={finish}
          className="rounded-xl px-3 py-2 text-xs text-fg-muted"
        >
          跳过指导
        </button>
        <button
          type="button"
          className="rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-on-accent"
          onClick={() => (step === 2 ? finish() : setStep(step + 1))}
        >
          {step === 2 ? '保存并开始听歌' : '下一步'}
        </button>
      </div>
      <p className="mt-3 text-[10px] text-fg-subtle">
        默认 3D 歌词 · 音量 20% · 原生画质 · 不限帧率 · HDR 关闭
      </p>
    </motion.aside>
  )
}
