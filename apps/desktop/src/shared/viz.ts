/**
 * 可视化帧的布局，与 Rust 端 `jap-analysis` 的常量一一对应；
 * 引擎宿主启动时会通过 `vizLayout()` 校验两边是否一致。
 */
export const VIZ = {
  headerLen: 8,
  bands: 128,
  waveLen: 256,
  gonioPoints: 128
} as const

export const VIZ_FRAME_LEN = VIZ.headerLen + VIZ.bands + VIZ.waveLen + VIZ.gonioPoints * 2

export const VIZ_OFFSET = {
  bands: VIZ.headerLen,
  wave: VIZ.headerLen + VIZ.bands,
  gonio: VIZ.headerLen + VIZ.bands + VIZ.waveLen
} as const

/** 头部各字段的下标。 */
export const VIZ_HEADER = { peakL: 0, peakR: 1, rmsL: 2, rmsR: 3, sampleRate: 4 } as const
