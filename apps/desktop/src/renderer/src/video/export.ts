import { create } from 'zustand'
import { fontOf, ensureFont } from '../fonts/catalog'
import { useCover } from '../cover/store'
import { createCoverCard, metadataOpacity } from './cover-card'
import { engine } from '../engine/client'
import { usePlayer } from '../engine/store'
import { activeVizHost } from '../components/Visualizer'
import { activeLyricsRenderer } from '../lyrics/LyricsLayer'
import { loadLyrics, useLyrics } from '../lyrics/store'
import { loadCover } from '../cover/store'
import { parseLRC, sungWidth } from '../lyrics/parse'
import { useSettings } from '../settings/store'
import { useViz } from '../viz/store'
import { activeAccents } from '../theme/store'
import type { VideoOptions, VideoQueueItem } from '@shared/video'
import { isMidiPath, discTrack, isDiscImage } from '@shared/audio'
import { createFrameEncoder, type FrameEncoder } from './encoder'
export type { VideoOptions } from '@shared/video'
export const useVideoQueue = create<{ jobs: VideoQueueItem[] }>(() => ({ jobs: [] }))
if (window.jap.surface === 'main') {
  window.jap.onVideoQueue((jobs) => useVideoQueue.setState({ jobs }))
  void window.jap.videoQueue().then((jobs) => useVideoQueue.setState({ jobs }))
}
/** Enqueue a snapshot; all actual rendering runs in the hidden export surface. */
export async function exportVideo(options: VideoOptions): Promise<VideoQueueItem | null> {
  const track = await usePlayer.getState().probe(options.path),
    v = useViz.getState()
  const settings = useSettings.getState()
  const { update: _update, ...saved } = settings
  return window.jap.enqueueVideo({
    options,
    title: track?.title || options.path.split(/[\\/]/).pop() || '音乐视频',
    settings: saved,
    visual: {
      viewport: { width: innerWidth, height: innerHeight },
      sceneId: v.sceneId,
      auto: false,
      offset: v.offset,
      zoom: v.zoom,
      userCustomOffset: v.userCustomOffset,
    },
  })
}
export const useVideoExport = create<{
  running: boolean
  progress: number
  status: string
  cancel: boolean
  error: string | null
  target: string | null
}>(() => ({ running: false, progress: 0, status: '', cancel: false, error: null, target: null }))
export async function renderVideoJob(options: VideoOptions): Promise<void> {
  if (window.jap.surface !== 'export') throw Error('视频任务必须由独立后台进程执行')
  if (useVideoExport.getState().running) return
  const state = useVideoExport.setState
  state({
    running: true,
    progress: 0,
    status: '准备编码器…',
    cancel: false,
    error: null,
    target: null,
  })
  let job: { id: string; encoder: string; target: string } | null = null,
    audioPath = ''
  let originalSourcePath: string | undefined
  let frameEncoder: FrameEncoder | null = null
  const player = usePlayer.getState()
  const settings = useSettings.getState(),
    mode = settings.lyricsMode,
    visible = settings.lyricsVisible,
    fps = settings.renderFps
  const auto = useViz.getState().auto
  let changed = false
  try {
    const track = await player.probe(options.path)
    if (!track) throw new Error('无法解码所选曲目')
    if (options.audio === 'copy' && isMidiPath(options.path))
      throw new Error('MIDI 是演奏指令，请选择 FLAC 或 PCM 保存合成后的音频')
    if (
      options.audio === 'copy' &&
      (discTrack(options.path) || isDiscImage(options.path) || /\.(dsf|dff)$/i.test(options.path))
    )
      throw new Error('当前音源不能直接封装为视频音轨，请选择 FLAC 或 PCM')
    if (options.audio === 'flac' && track.format.float && !isMidiPath(options.path))
      throw new Error('FLAC 不存储浮点样本；请选原音频直封以完整保留浮点音轨，或选择 PCM 32 位整数')
    const end =
      options.end > 0
        ? Math.min(options.end, (track.durationMs ?? options.end * 1000) / 1000)
        : (track.durationMs ?? 0) / 1000
    const duration = end - options.start,
      total = duration + options.intro + options.outro
    if (duration <= 0 || options.start < 0)
      throw new Error('结束时间必须晚于开始时间；未知时长请填写结束时间')
    if (options.audio === 'copy' && /\.ncm$/i.test(options.path))
      originalSourcePath = (await engine.offline('original', { path: options.path })).audioPath
    frameEncoder = await createFrameEncoder(
      options.width,
      options.height,
      options.fps,
      options.quality,
      options.encoder
    )
    job = await window.jap.videoStart({
      ...options,
      transport: frameEncoder ? 'h264' : 'rgba',
      midiSoundfont: settings.midiSoundfont,
      musicDuration: duration,
      originalSourcePath,
      audioBits: isMidiPath(options.path)
        ? 24
        : !track.format.float && [16, 24, 32].includes(track.format.bits ?? 0)
          ? track.format.bits!
          : 32,
      duration: total,
      title: track.title ?? track.path.split(/[\\/]/).pop() ?? '音乐视频',
    })
    if (!job) return
    const jobId = job.id
    frameEncoder?.setWriter((data) => window.jap.videoFrame(jobId, data))
    changed = true
    useViz.getState().setAuto(false)
    useSettings.setState({
      lyricsMode: options.lyrics === '3d' ? '3d' : '2d',
      lyricsVisible: options.lyrics !== 'none',
      renderFps: 0,
    })
    await Promise.all([loadCover(options.path), loadLyrics(options.path), document.fonts.ready])
    await new Promise<void>((ok) => setTimeout(ok, 100))
    if (options.lyrics === '3d') await activeLyricsRenderer?.prepareForExport()
    const opened = await engine.offline('open', {
      path: options.path,
      writeAudio: options.audio !== 'copy',
      soundfont: settings.midiSoundfont,
      midiRate: settings.midiSampleRate,
      startMs: Math.round(options.start * 1000),
    })
    audioPath = opened.audioPath ?? ''
    const canvas = document.createElement('canvas')
    canvas.width = options.width
    canvas.height = options.height
    const c = canvas.getContext('2d', { alpha: false, willReadFrequently: !frameEncoder })!
    const lines = parseLRC(useLyrics.getState().text ?? ''),
      font = fontOf(settings.lyricsFont)
    await ensureFont(settings.lyricsFont)
    await document.fonts.load(`${font.weight} 48px "${font.family}"`)
    const accent = activeAccents().primary,
      w = canvas.width,
      h = canvas.height,
      count = Math.ceil(total * options.fps)
    const card = await createCoverCard(
      track,
      useCover.getState().art?.url ?? null,
      accent,
      w,
      h,
      options.coverFont ?? settings.videoCoverFont,
      options.signature ?? settings.videoSignature
    )
    state({ status: `离线渲染 · ${job.encoder}` })
    for (let i = 0; i < count; i++) {
      if (useVideoExport.getState().cancel) throw new Error('导出已取消')
      const time = i / options.fps,
        music = Math.max(0, Math.min(duration, time - options.intro))
      const result = await engine.offline('frame', { timeMs: music * 1000 })
      if (!result.frame || !activeVizHost) throw new Error('渲染器已关闭')
      const began = performance.now()
      const stage = activeVizHost.renderOffline(
        result.frame,
        options.start + music,
        w,
        h,
        options.fps
      )
      c.drawImage(stage, 0, 0, w, h)
      const debug = new URLSearchParams(location.search).has('e2e') && i === 30
      if (debug) (window as unknown as Record<string, unknown>)['__exportStage'] = stage.toDataURL()
      const inMusic = time >= options.intro && time < options.intro + duration
      if (inMusic && options.lyrics === '3d' && activeLyricsRenderer) {
        const layer = activeLyricsRenderer.renderOffline(
          options.start + music,
          1 / options.fps,
          w,
          h
        )
        c.drawImage(layer, 0, 0, w, h)
        if (debug)
          (window as unknown as Record<string, unknown>)['__exportLyrics'] = layer.toDataURL()
      } else if (inMusic && options.lyrics === '2d') {
        let at = -1
        for (let n = 0; n < lines.length && lines[n]!.t <= options.start + music; n++) at = n
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.shadowColor = accent
        c.shadowBlur = settings.lyricsShadow ? 18 : 0
        for (let n = -1; n <= 1; n++) {
          const line = lines[at + n]
          if (!line) continue
          c.globalAlpha = n === 0 ? 1 : 0.35
          c.fillStyle = n === 0 ? (line.words?.length ? '#bbbbc4' : accent) : '#ffffff'
          c.font = `${font.weight} ${Math.round((h * (n === 0 ? 0.05 : 0.034) * settings.lyricsSize) / 100)}px "${font.family}"`
          c.fillText(
            line.text,
            w * 0.5,
            h * 0.73 + (n * h * 0.067 * settings.lyricsSize) / 100,
            w * 0.88
          )
          if (n === 0 && line.words?.length) {
            const full = c.measureText(line.text).width,
              fit = Math.min(1, (w * 0.88) / Math.max(1, full))
            const fill =
              sungWidth(
                line.words,
                options.start + music,
                (t) => c.measureText(t).width,
                line.text
              ) * fit
            // Draw the pending text dim, then reveal the accent with the same word clock.
            const y = h * 0.73
            c.save()
            c.shadowBlur = 0
            c.beginPath()
            c.rect(w * 0.5 - full * fit * 0.5, 0, fill, h)
            c.clip()
            c.fillStyle = accent
            c.fillText(line.text, w * 0.5, y, w * 0.88)
            c.restore()
          }
          if (n === 0 && line.sub) {
            c.font = `${font.weight} ${Math.round((h * 0.025 * settings.lyricsSize) / 100)}px "${font.family}"`
            c.fillText(line.sub, w * 0.5, h * 0.77, w * 0.85)
          }
        }
        c.globalAlpha = 1
        c.shadowBlur = 0
      }
      if (!inMusic) {
        const intro = time < options.intro,
          local = intro ? time : time - options.intro - duration
        c.save()
        c.globalAlpha = metadataOpacity(local, intro ? options.intro : options.outro, options.fps)
        c.drawImage(card, 0, 0)
        c.restore()
      }
      if (frameEncoder) await frameEncoder.encode(canvas, i)
      else
        await window.jap.videoFrame(job.id, new Uint8Array(c.getImageData(0, 0, w, h).data.buffer))
      state({ progress: (i + 1) / count, status: `后台生成 · ${job.encoder} · ${i + 1}/${count}` })
      if (options.renderPriority !== 'fast')
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(2, performance.now() - began))
        )
    }
    await frameEncoder?.finish()
    await engine.offline('frame', { timeMs: duration * 1000 })
    await engine.offline('close')
    state({ status: '正在合并音频…' })
    const target = await window.jap.videoFinish(job.id, audioPath)
    job = null
    state({ status: '导出完成', target, progress: 1 })
  } catch (error) {
    state({
      error: String(error),
      status: useVideoExport.getState().cancel ? '已取消' : '导出失败',
    })
  } finally {
    frameEncoder?.close()
    await engine.offline('close').catch(() => {})
    if (job) await window.jap.videoCancel(job.id, audioPath).catch(() => {})
    if (originalSourcePath) await window.jap.videoCancel('', originalSourcePath).catch(() => {})
    activeVizHost?.endOffline()
    activeLyricsRenderer?.endOffline()
    if (changed) {
      useSettings.setState({ lyricsMode: mode, lyricsVisible: visible, renderFps: fps })
      useViz.getState().setAuto(auto)
      await Promise.all([loadCover(null), loadLyrics(null)])
    }
    state({ running: false })
  }
}
