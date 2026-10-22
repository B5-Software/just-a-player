import {
  LYRICS_FONTS,
  type LyricsPosition,
  type LyricsPose,
  type LyricsMode
} from '@shared/settings'
import { usePlayer } from '../engine/store'
import { Cursor, TextAa } from '../icons'
import { effectivePose, POSE_OPTIONS } from '../lyrics/pose'
import { clearImportedLyrics, importLyricsFor, useLyrics } from '../lyrics/store'
import { useSettings } from '../settings/store'
import { useUi } from '../ui/store'
import { SectionTitle, SettingRow, Slider, Toggle } from '../ui/controls'
import { Segmented, type SegmentOption } from './Segmented'
import { useState } from 'react'
import { useFontCatalog, importFontFiles } from '../fonts/catalog'

const MODE_OPTIONS: readonly SegmentOption<LyricsMode>[] = [
  { value: '2d', label: '2D 优雅' },
  { value: '3d', label: '3D 空间' }
]

const POSITION_OPTIONS: readonly SegmentOption<LyricsPosition>[] = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' },
  { value: 'bottom', label: '底部' },
  { value: 'custom', label: '自定义' }
]

const POSE_LABEL = Object.fromEntries(POSE_OPTIONS.map((p) => [p.id, p.label])) as Record<
  LyricsPose,
  string
>
const POSITION_LABEL: Record<LyricsPosition, string> = {
  left: '左侧',
  center: '居中',
  right: '右侧',
  bottom: '底部',
  custom: '自定义'
}

/** 歌词 HUD：显示、模式（2D/3D）、阴影、位置、姿态（旋转）、字体，以及歌词文件。 */
export function LyricsPanel(): React.JSX.Element {
  const visible = useSettings((s) => s.lyricsVisible)
  const mode = useSettings((s) => s.lyricsMode)
  const shadow = useSettings((s) => s.lyricsShadow)
  const position = useSettings((s) => s.lyricsPosition)
  const pose = useSettings((s) => s.lyricsPose)
  const rotation = useSettings((s) => s.lyricsRotation)
  const spin = useSettings((s) => s.lyricsSpin)
  const font = useSettings((s) => s.lyricsFont)
  const size = useSettings((s) => s.lyricsSize)
  const imported = useFontCatalog((s) => s.imported)
  const [fontStatus, setFontStatus] = useState('')
  const update = useSettings((s) => s.update)
  const adjusting = useUi((s) => s.lyricsAdjusting)
  const setAdjusting = useUi((s) => s.setLyricsAdjusting)
  const source = useLyrics((s) => s.source)
  const path = useLyrics((s) => s.path)
  const trackPath = usePlayer((s) => s.track?.path ?? null)

  const effective = effectivePose(pose, position)

  return (
    <div className="flex flex-col gap-6">
      <SettingRow title="显示歌词">
        <Toggle checked={visible} onChange={(v) => update({ lyricsVisible: v })} label="显示歌词" />
      </SettingRow>

      <section className="flex flex-col gap-2.5">
        <SectionTitle>渲染模式</SectionTitle>
        <Segmented
          aria-label="歌词渲染模式"
          size="sm"
          value={mode}
          options={MODE_OPTIONS}
          onChange={(value) => update({ lyricsMode: value })}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
        />
      </section>

      <SettingRow
        title="增强文字阴影"
        hint="添加深色柔和投影与轮廓光晕，在浅色或复杂背景下也能清晰阅读"
      >
        <Toggle
          checked={shadow}
          onChange={(v) => update({ lyricsShadow: v })}
          label="增强文字阴影"
        />
      </SettingRow>

      <section className="flex flex-col gap-3">
        <SectionTitle>位置</SectionTitle>
        <Segmented
          aria-label="歌词位置"
          size="sm"
          value={position}
          options={POSITION_OPTIONS}
          onChange={(value) => update({ lyricsPosition: value })}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
        />
        <div className="p-0.5">
          <button
            type="button"
            aria-pressed={adjusting}
            onClick={() => setAdjusting(!adjusting)}
            className={`w-full inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium ring-1 transition-colors ${
              adjusting
                ? 'bg-accent text-on-accent ring-accent'
                : 'bg-hover text-fg ring-line hover:bg-hover/70'
            }`}
          >
            <Cursor size={16} />
            {adjusting ? '完成，记住位置' : '拖动调整位置'}
          </button>
        </div>
        <p className="text-xs leading-relaxed text-fg-muted">
          当前：{POSITION_LABEL[position]}。拖动时歌词跟随指针，松手后记为自定义位置。
        </p>
      </section>

      {mode === '3d' && (
        <section className="flex flex-col gap-3">
          <SectionTitle>3D 姿态</SectionTitle>
          <div className="grid grid-cols-2 gap-2 p-1 -m-1">
            {POSE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={pose === option.id}
                onClick={() => update({ lyricsPose: option.id })}
                className={`rounded-xl px-2.5 py-2 text-left text-xs font-medium ring-1 transition-colors ${
                  pose === option.id
                    ? 'bg-accent text-on-accent ring-accent'
                    : 'bg-hover text-fg ring-line'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-fg-muted">
            {pose === 'auto'
              ? `跟随位置：当前为${POSE_LABEL[effective]}。居中不转，偏右俯视 Z 顺时针，偏左俯视 Z 逆时针，底部后仰。`
              : `当前姿态：${POSE_LABEL[pose]}`}
          </p>
          {pose === 'free' && (
            <div className="flex flex-col gap-3">
              {(['x', 'y', 'z'] as const).map((axis) => (
                <div key={axis} className="flex flex-col gap-1">
                  <span className="text-xs text-fg-muted">
                    {axis.toUpperCase()} 轴 ·{' '}
                    {axis === 'x' ? '俯仰' : axis === 'y' ? '偏航' : '滚转'}
                  </span>
                  <Slider
                    label={`${axis.toUpperCase()} 轴旋转`}
                    value={rotation[axis]}
                    min={-180}
                    max={180}
                    step={1}
                    format={(v) => `${v}°`}
                    onChange={(v) => update({ lyricsRotation: { ...rotation, [axis]: v } })}
                  />
                </div>
              ))}
            </div>
          )}
          {pose === 'sphere' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">旋转速度</span>
              <Slider
                label="球形旋转速度"
                value={spin}
                min={0}
                max={1}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => update({ lyricsSpin: v })}
              />
            </div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <SectionTitle>字体</SectionTitle>
        <Slider
          label="歌词字号"
          value={size}
          min={50}
          max={200}
          step={5}
          format={(v) => `${v}%`}
          onChange={(lyricsSize) => update({ lyricsSize })}
        />
        <p className="text-xs text-fg-muted">
          内置字体均为 SIL OFL，毛笔、手写与圆润风格可自由选择。
        </p>
        <div className="grid grid-cols-2 gap-2 p-1">
          {[...LYRICS_FONTS, ...imported].map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={font === f.id}
              onClick={() => update({ lyricsFont: f.id })}
              style={{ fontFamily: `"${f.family}", sans-serif` }}
              title={f.label}
              className={`flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-sm ring-1 transition-colors ${
                font === f.id
                  ? 'bg-accent text-on-accent ring-accent'
                  : 'bg-hover text-fg ring-line'
              }`}
            >
              <TextAa size={14} className="shrink-0" />
              <span className="min-w-0 truncate whitespace-nowrap text-left">{f.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="rounded-xl bg-hover px-3 py-2 text-sm text-fg"
          onClick={() => {
            setFontStatus('正在导入…')
            void importFontFiles()
              .then(({ fonts, errors }) => {
                if (fonts[0]) update({ lyricsFont: fonts[0].id })
                setFontStatus(
                  errors.length
                    ? errors.join('\n')
                    : fonts.length
                      ? `已导入 ${fonts.length} 款字体`
                      : ''
                )
              })
              .catch((e) => setFontStatus(String(e)))
          }}
        >
          导入字体…
        </button>
        <p className="text-xs leading-relaxed text-fg-muted">
          支持
          TTF、OTF、WOFF、WOFF2、TTC、OTC；字体集合逐个字面导入，保存在应用内，歌词和视频封面均可使用。
        </p>
        {fontStatus && (
          <p role="status" className="whitespace-pre-wrap text-xs text-fg-muted">
            {fontStatus}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>歌词文件</SectionTitle>
        <p className="text-sm text-fg-muted">
          {source === 'imported'
            ? '正在使用导入的歌词（优先于同名 .lrc）'
            : source === 'sidecar'
              ? '正在使用同名 .lrc 文件'
              : source === 'embedded'
                ? '正在使用音频元数据内嵌歌词'
              : path
                ? '这首歌没有歌词'
                : '开始播放后可以为这首歌导入歌词'}
        </p>
        <div className="flex gap-2 p-1 -m-1">
          <button
            type="button"
            disabled={!trackPath}
            onClick={() => trackPath && void importLyricsFor(trackPath)}
            className="flex-1 rounded-xl bg-hover px-3 py-2 text-sm font-medium text-fg ring-1 ring-line transition-colors hover:bg-hover/70 disabled:opacity-40"
          >
            导入 LRC…
          </button>
          {source === 'imported' && trackPath && (
            <button
              type="button"
              onClick={() => void clearImportedLyrics(trackPath)}
              className="rounded-xl px-3 py-2 text-sm text-fg-muted ring-1 ring-line transition-colors hover:text-fg"
            >
              清除
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
