import { BrowserWindow, dialog, ipcMain, app } from 'electron'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdtemp, rm, unlink, rmdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/ipc'
import { queueTarget } from './video-queue'
const exec = promisify(execFile)
interface Options {
  queueId?: string
  audio?: 'aac' | 'opus' | 'flac' | 'pcm' | 'copy'
  audioBitrate?: number
  audioBits?: number
  path?: string
  start?: number
  outro?: number
  musicDuration?: number
  originalSourcePath?: string
  width: number
  height: number
  fps: number
  quality: number
  encoder: string
  intro: number
  duration: number
  title: string
}
interface Job {
  muxAbort?: AbortController
  id: string
  owner: number
  dir: string
  target: string
  child: ChildProcessWithoutNullStreams
  finished: Promise<void>
  error: string
  options: Options
  encoder: string
}
let job: Job | null = null
const encoders = new Map<string, string>()
async function encoder(request: string): Promise<string> {
  const cached = encoders.get(request)
  if (cached) return cached
  const choices =
    request === 'auto' ? ['h264_nvenc', 'h264_qsv', 'h264_amf'] : request === 'cpu' ? [] : [request]
  for (const name of choices) {
    try {
      await exec(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=s=64x64:d=0.05',
          '-frames:v',
          '1',
          '-c:v',
          name,
          '-f',
          'null',
          '-'
        ],
        { windowsHide: true, timeout: 15000 }
      )
      encoders.set(request, name)
      return name
    } catch {
      /* Hardware unavailable; try next encoder. */
    }
  }
  encoders.set(request, 'libx264')
  return 'libx264'
}
async function cleanAudio(path: string): Promise<void> {
  const dir = dirname(resolve(path))
  if (
    !(
      (basename(path) === 'audio.wav' && basename(dir).startsWith('jap-render-audio-')) ||
      (basename(path) === 'source.audio' && basename(dir).startsWith('jap-render-source-'))
    ) ||
    dirname(dir).toLowerCase() !== resolve(tmpdir()).toLowerCase()
  )
    return
  await unlink(path).catch(() => {})
  await rmdir(dir).catch(() => {})
}
async function clean(j: Job): Promise<void> {
  if (
    dirname(j.dir).toLowerCase() === resolve(tmpdir()).toLowerCase() &&
    basename(j.dir).startsWith('jap-render-video-')
  )
    await rm(j.dir, { recursive: true, force: true })
}
export function registerVideoIpc(trusted: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(IPC.videoStart, async (event, options: Options) => {
    if (!trusted(event) || job) throw new Error('已有导出任务')
    if (
      !options ||
      (options.audio !== undefined &&
        !['aac', 'opus', 'flac', 'pcm', 'copy'].includes(options.audio)) ||
      ![24, 30, 60].includes(options.fps) ||
      ![18, 23, 28].includes(options.quality) ||
      !['auto', 'cpu', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(options.encoder) ||
      ![options.width, options.height, options.duration, options.intro].every(Number.isFinite) ||
      options.width < 320 ||
      options.width > 3840 ||
      options.height < 180 ||
      options.height > 2160 ||
      options.width % 2 ||
      options.height % 2 ||
      options.duration <= 0 ||
      options.duration > 86400 ||
      options.intro < 0 ||
      options.intro > 10
    )
      throw new Error('无效视频参数')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const queued = queueTarget(event.sender, options.queueId)
    const selected = queued
      ? { canceled: false, filePath: queued }
      : await dialog.showSaveDialog(win, {
          title: '导出音乐视频',
          defaultPath: (options.title || '音乐视频').replace(/[<>:"/\\|?*]/g, '_') + '.mp4',
          filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
        })
    if (selected.canceled || !selected.filePath) return null
    const dir = await mkdtemp(join(tmpdir(), 'jap-render-video-'))
    const name = await encoder(options.encoder)
    const quality =
      name === 'libx264'
        ? ['-preset', 'veryfast', '-crf', String(options.quality)]
        : name === 'h264_nvenc'
          ? ['-preset', 'p4', '-cq', String(options.quality)]
          : name === 'h264_qsv'
            ? ['-global_quality', String(options.quality)]
            : ['-qp_i', String(options.quality), '-qp_p', String(options.quality)]
    const child = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgba',
        '-video_size',
        `${options.width}x${options.height}`,
        '-framerate',
        String(options.fps),
        '-i',
        'pipe:0',
        '-an',
        '-c:v',
        name,
        ...quality,
        '-pix_fmt',
        'yuv420p',
        join(dir, 'video.mp4')
      ],
      { windowsHide: true, stdio: 'pipe' }
    )
    const j: Job = {
      id: randomUUID(),
      owner: event.sender.id,
      dir,
      target: selected.filePath,
      child,
      options,
      encoder: name,
      error: '',
      finished: Promise.resolve()
    }
    child.stderr.on('data', (b: Buffer) => {
      j.error = (j.error + b.toString()).slice(-8192)
    })
    child.stdin.on('error', (error) => {
      j.error = String(error)
    })
    j.finished = new Promise<void>((ok, fail) => {
      child.on('error', fail)
      child.on('close', (code) =>
        code === 0 ? ok() : fail(new Error(j.error || `FFmpeg exit ${code}`))
      )
    })
    void j.finished.catch(() => {
      encoders.delete(options.encoder)
    })
    job = j
    return { id: j.id, encoder: name, target: j.target }
  })
  ipcMain.handle(IPC.videoFrame, async (event, id: string, data: Uint8Array) => {
    const j = job
    if (
      !trusted(event) ||
      !j ||
      j.owner !== event.sender.id ||
      j.id !== id ||
      !(data instanceof Uint8Array) ||
      data.byteLength !== j.options.width * j.options.height * 4
    )
      throw new Error('无效视频帧')
    await new Promise<void>((ok, fail) =>
      j.child.stdin.write(data, (error) => (error ? fail(error) : ok()))
    )
  })
  ipcMain.handle(IPC.videoFinish, async (event, id: string, audioPath: string) => {
    const j = job
    if (
      !trusted(event) ||
      !j ||
      j.owner !== event.sender.id ||
      j.id !== id ||
      typeof audioPath !== 'string'
    )
      throw new Error('无效导出任务')
    try {
      j.child.stdin.end()
      await j.finished
      const audio = j.options.audio ?? 'aac',
        bitrate = [96, 128, 192, 256, 320, 512].includes(j.options.audioBitrate ?? 320)
          ? (j.options.audioBitrate ?? 320)
          : 320
      const musicDuration =
        j.options.musicDuration ?? j.options.duration - j.options.intro - (j.options.outro ?? 0)
      const source = audio === 'copy' ? (j.options.originalSourcePath ?? j.options.path) : audioPath
      if (!source || (audio === 'copy' && /\.(dsf|dff|iso|cue|bin)$/i.test(source)))
        throw new Error('当前音源无法直接封装为视频音轨，请选择 FLAC 无损或 PCM')
      j.muxAbort = new AbortController()
      if (audio === 'copy') {
        // Cut before applying the intro offset. FFmpeg input -t also counts
        // itsoffset; combining them would silently shorten the original audio.
        await exec(
          'ffmpeg',
          [
            '-v',
            'error',
            '-y',
            '-ss',
            String(j.options.start ?? 0),
            '-t',
            String(musicDuration),
            '-i',
            source,
            '-map',
            '0:a:0',
            '-c:a',
            'copy',
            join(j.dir, 'original.mka')
          ],
          { windowsHide: true, timeout: 600000, maxBuffer: 8192, signal: j.muxAbort.signal }
        )
      }
      const input =
        audio === 'copy'
          ? ['-itsoffset', String(j.options.intro), '-i', join(j.dir, 'original.mka')]
          : ['-i', audioPath]
      const format = audio === 'aac' ? 'mp4' : 'mkv'
      const audioEncoder =
        audio === 'copy'
          ? ['-c:a', 'copy']
          : [
              '-c:a',
              audio === 'flac'
                ? 'flac'
                : audio === 'pcm'
                  ? 'pcm_s32le'
                  : audio === 'opus'
                    ? 'libopus'
                    : 'aac',
              ...(audio === 'flac'
                ? [
                    '-strict',
                    '-2',
                    '-bits_per_raw_sample',
                    String(
                      [16, 24, 32].includes(j.options.audioBits ?? 32)
                        ? (j.options.audioBits ?? 32)
                        : 32
                    )
                  ]
                : audio === 'pcm'
                  ? []
                  : ['-b:a', `${bitrate}k`]),
              '-af',
              `atrim=duration=${musicDuration},asetpts=PTS-STARTPTS+${j.options.intro}/TB,apad`
            ]
      await exec(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-i',
          join(j.dir, 'video.mp4'),
          ...input,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:v',
          'copy',
          ...audioEncoder,
          '-t',
          String(j.options.duration),
          ...(format === 'mp4' ? ['-movflags', '+faststart'] : []),
          join(j.dir, `final.${format}`)
        ],
        { windowsHide: true, timeout: 600000, maxBuffer: 8192, signal: j.muxAbort.signal }
      )
      const staged = join(dirname(j.target), `.jap-${j.id}.tmp`)
      try {
        await copyFile(join(j.dir, `final.${format}`), staged)
        j.muxAbort.signal.throwIfAborted()
        await rename(staged, j.target)
      } finally {
        await unlink(staged).catch(() => {})
      }
      return j.target
    } finally {
      if (job === j) job = null
      await clean(j)
      await cleanAudio(audioPath)
      if (j.options.originalSourcePath) await cleanAudio(j.options.originalSourcePath)
    }
  })
  ipcMain.handle(IPC.videoCancel, async (event, id: string, audioPath?: string) => {
    const j = job
    if (!trusted(event)) return
    if (!j) {
      if (audioPath) await cleanAudio(audioPath)
      return
    }
    if (j.owner !== event.sender.id || j.id !== id) return
    job = null
    j.child.kill()
    j.muxAbort?.abort()
    await j.finished.catch(() => {})
    await clean(j)
    if (audioPath) await cleanAudio(audioPath)
    if (j.options.originalSourcePath) await cleanAudio(j.options.originalSourcePath)
  })
  app.on('before-quit', () => job?.child.kill())
}
export async function cancelVideoOwner(owner: number): Promise<void> {
  const j = job
  if (!j || j.owner !== owner) return
  job = null
  j.child.kill()
  j.muxAbort?.abort()
  await j.finished.catch(() => {})
  await clean(j)
  if (j.options.originalSourcePath) await cleanAudio(j.options.originalSourcePath)
}
