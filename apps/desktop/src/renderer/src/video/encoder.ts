/** GPU-backed VideoFrames avoid the full RGBA readback used by FFmpeg raw input. */
export interface FrameEncoder {
  encode(canvas: HTMLCanvasElement, index: number): Promise<void>
  finish(): Promise<void>
  close(): void
  setWriter(writer: (data: Uint8Array) => Promise<void>): void
}
export async function createFrameEncoder(
  width: number,
  height: number,
  fps: number,
  quality: number,
  requested: string
): Promise<FrameEncoder | null> {
  if (
    requested !== 'auto' ||
    typeof VideoEncoder === 'undefined' ||
    typeof VideoFrame === 'undefined'
  )
    return null
  const codec =
    width * height > 1920 * 1080 ? 'avc1.640034' : fps > 30 ? 'avc1.42002a' : 'avc1.420028'
  const config: VideoEncoderConfig = {
    codec,
    width,
    height,
    framerate: fps,
    bitrate: Math.round(
      Math.min(
        100000000,
        Math.max(
          1000000,
          width * height * fps * (quality <= 18 ? 0.22 : quality <= 23 ? 0.14 : 0.09)
        )
      )
    ),
    avc: { format: 'annexb' },
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
  }
  try {
    if (!(await VideoEncoder.isConfigSupported(config)).supported) return null
  } catch {
    return null
  }
  let failure: unknown = null,
    writes = Promise.resolve(),
    write: ((data: Uint8Array) => Promise<void>) | null = null
  const encoder = new VideoEncoder({
    error: (e) => {
      failure = e
    },
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength)
      chunk.copyTo(bytes)
      writes = writes.then(async () => {
        if (failure) throw failure
        if (!write) throw Error('视频编码输出未连接')
        await write(bytes)
      })
      void writes.catch((e) => {
        failure = e
      })
    },
  })
  try {
    encoder.configure(config)
  } catch {
    encoder.close()
    return null
  }
  return {
    setWriter: (writer) => {
      write = writer
    },
    async encode(canvas, index) {
      if (failure) throw failure
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((index * 1000000) / fps),
        duration: Math.round(1000000 / fps),
      })
      try {
        encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 })
      } finally {
        frame.close()
      }
      // Bounded queues, including Java/FFmpeg writes: never accumulate a whole video.
      if (encoder.encodeQueueSize >= 2 || index % 4 === 3) {
        await encoder.flush()
        await writes
      }
    },
    async finish() {
      await encoder.flush()
      await writes
      if (failure) throw failure
    },
    close() {
      if (encoder.state !== 'closed') encoder.close()
    },
  }
}
