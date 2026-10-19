import { useState } from 'react'
import { usePlayer } from '../engine/store'
import { useLibrary, displayTitle } from '../library/store'
import { exportVideo, useVideoQueue, type VideoOptions } from '../video/export'
import { Toggle, SettingRow, SectionTitle } from '../ui/controls'
import { LYRICS_FONTS } from '@shared/settings'
import { useSettings } from '../settings/store'
import { useFontCatalog } from '../fonts/catalog'
import { useUi } from '../ui/store'
export function VideoPanel(): React.JSX.Element {
  const track = usePlayer((s) => s.track),
    lists = useLibrary((s) => s.lists),
    selected = useLibrary((s) => s.selected)
  const selectedTrack = lists.flatMap((l) => l.items).find((i) => selected.includes(i.id))
  const [source, setSource] = useState<'current' | 'selected'>('current')
  const [size, setSize] = useState('1920x1080'),
    [fps, setFps] = useState(30),
    [quality, setQuality] = useState(18),
    [encoder, setEncoder] = useState('auto')
  const [intro, setIntro] = useState(true),
    [outro, setOutro] = useState(true),
    [lyrics, setLyrics] = useState<VideoOptions['lyrics']>('3d')
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(0)
  const jobs = useVideoQueue((s) => s.jobs)
  const [audio, setAudio] = useState<NonNullable<VideoOptions['audio']>>('aac'),
    [audioBitrate, setAudioBitrate] = useState(320),
    [message, setMessage] = useState('')
  const signature = useSettings((s) => s.videoSignature),
    coverFont = useSettings((s) => s.videoCoverFont),
    update = useSettings((s) => s.update),
    imported = useFontCatalog((s) => s.imported)
  const path = source === 'selected' ? selectedTrack?.path : track?.path
  const selectClass = 'rounded-xl bg-hover p-2 text-xs text-fg'
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-fg-muted">
        独立后台渲染，继续听歌与操作播放器。任务加入队列时保存当前场景、歌词、字体与署名，按顺序导出。
      </p>
      <fieldset className="space-y-4">
        <SectionTitle>歌曲与画面</SectionTitle>
        <SettingRow title="音源">
          <select
            aria-label="导出音源"
            value={source}
            onChange={(e) => setSource(e.target.value as 'current' | 'selected')}
            className={selectClass}
          >
            <option value="current">当前歌曲</option>
            <option value="selected" disabled={!selectedTrack}>
              列表选中歌曲
            </option>
          </select>
        </SettingRow>
        <p className="truncate text-xs text-accent-text">
          {source === 'selected' && selectedTrack
            ? displayTitle(selectedTrack)
            : (track?.title ?? track?.path ?? '请先选择歌曲')}
        </p>
        <SettingRow title="分辨率">
          <select
            aria-label="视频分辨率"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            className={selectClass}
          >
            {['1280x720', '1920x1080', '2560x1440', '3840x2160', '1080x1920', '1080x1080'].map(
              (s) => (
                <option key={s}>{s}</option>
              )
            )}
          </select>
        </SettingRow>
        <SettingRow title="帧率">
          <select
            aria-label="视频帧率"
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
            className={selectClass}
          >
            {[24, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n} FPS
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="编码器">
          <select
            aria-label="视频编码器"
            value={encoder}
            onChange={(e) => setEncoder(e.target.value)}
            className={selectClass}
          >
            <option value="auto">自动 · 优先硬件加速</option>
            <option value="cpu">CPU · H.264</option>
            <option value="h264_nvenc">NVIDIA NVENC</option>
            <option value="h264_qsv">Intel QSV</option>
            <option value="h264_amf">AMD AMF</option>
          </select>
        </SettingRow>
        <SettingRow title="画质">
          <select
            aria-label="视频画质"
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            className={selectClass}
          >
            <option value={18}>高 · 18</option>
            <option value={23}>均衡 · 23</option>
            <option value={28}>小体积 · 28</option>
          </select>
        </SettingRow>
        <SettingRow title="音频质量">
          <select
            aria-label="视频音频质量"
            value={audio}
            onChange={(e) => setAudio(e.target.value as typeof audio)}
            className={selectClass}
          >
            <option value="aac">AAC · MP4</option>
            <option value="opus">Opus · MKV</option>
            <option value="flac">FLAC 无损 · MKV</option>
            <option value="pcm">PCM 32 位 · MKV</option>
            <option value="copy">原音频直封 · MKV</option>
          </select>
        </SettingRow>
        {(audio === 'aac' || audio === 'opus') && (
          <SettingRow title="音频码率">
            <select
              aria-label="视频音频码率"
              value={audioBitrate}
              onChange={(e) => setAudioBitrate(Number(e.target.value))}
              className={selectClass}
            >
              {[96, 128, 192, 256, 320, 512]
                .filter((n) => audio === 'opus' || n <= 320)
                .map((n) => (
                  <option key={n} value={n}>
                    {n} kbps
                  </option>
                ))}
            </select>
          </SettingRow>
        )}
        <p className="text-[11px] leading-relaxed text-fg-muted">
          FLAC / PCM
          保留解码后的原采样率与声道。原音频直封保留原始音轨，按编码帧截取；容器不支持的音源需选择
          FLAC。32 位 FLAC 需新版解码器；浮点音源若需完整保留请选择原音频直封。DSD 的 PCM
          预览不等于原生 DSD 音轨。
        </p>
        <SettingRow title="歌词">
          <select
            aria-label="视频歌词"
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value as VideoOptions['lyrics'])}
            className={selectClass}
          >
            <option value="3d">当前字体与姿态 · 3D</option>
            <option value="2d">居中滚动 · 2D</option>
            <option value="none">关闭</option>
          </select>
        </SettingRow>
        <SettingRow title="片头显示元数据 · 2 秒">
          <Toggle label="片头元数据" checked={intro} onChange={setIntro} />
        </SettingRow>
        <SettingRow title="片尾显示元数据 · 2 秒">
          <Toggle label="片尾元数据" checked={outro} onChange={setOutro} />
        </SettingRow>
        <SettingRow
          title="片头片尾字体"
          hint="封面与元数据渐显渐隐，排版自动适配横屏、竖屏与方形。"
        >
          <select
            aria-label="视频封面字体"
            value={coverFont}
            onChange={(e) => update({ videoCoverFont: e.target.value as typeof coverFont })}
            className={`${selectClass} max-w-44`}
          >
            {[...LYRICS_FONTS, ...imported].map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <label className="flex flex-col gap-2 text-xs text-fg-muted">
          自定义署名 · 留空不显示
          <input
            aria-label="视频自定义署名"
            value={signature}
            maxLength={80}
            onChange={(e) => update({ videoSignature: e.target.value })}
            className="rounded-xl bg-hover p-3 text-fg"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ['开始秒数', start, setStart],
              ['结束秒数 · 0 为曲终', end, setEnd]
            ] as const
          ).map(([label, value, setter]) => (
            <label key={label} className="flex flex-col gap-2 text-xs text-fg-muted">
              {label}
              <input
                aria-label={label}
                type="number"
                min={0}
                value={value}
                onChange={(e) => setter(Number(e.target.value))}
                className="rounded-xl bg-hover p-2 text-fg"
              />
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="button"
        disabled={!path}
        className="rounded-xl bg-accent p-3 text-sm font-semibold text-on-accent disabled:opacity-40"
        onClick={() => {
          if (path) {
            const [width, height] = size.split('x').map(Number)
            void exportVideo({
              path,
              width: width!,
              height: height!,
              fps,
              quality,
              encoder,
              intro: intro ? 2 : 0,
              outro: outro ? 2 : 0,
              start,
              end,
              lyrics,
              signature,
              coverFont,
              audio,
              audioBitrate
            })
              .then((job) => setMessage(job ? '已加入后台导出队列' : ''))
              .catch((e) => setMessage(String(e)))
          }
        }}
      >
        加入导出队列
      </button>
      <p role="status" className="break-all text-xs text-fg-muted">
        {message}
      </p>
      <button
        type="button"
        className="rounded-xl bg-hover p-3 text-xs text-accent-text"
        onClick={() => useUi.getState().togglePanel('exports')}
      >
        查看导出队列 · {jobs.filter((j) => j.state === 'waiting' || j.state === 'rendering').length}{' '}
        个进行中
      </button>
      <p className="text-[11px] text-fg-muted">
        支持 NCM、DSD 等解码来源；编码由 FFmpeg 完成，可自动选择可用的硬件视频编码器。
      </p>
    </div>
  )
}
