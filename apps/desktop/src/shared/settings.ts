import { isThemeMode, type ThemeMode } from './theme'

export const DEFAULT_ACCENT = '#8476ff'

export const LYRICS_POSITIONS = ['left', 'center', 'right', 'bottom', 'custom'] as const
export type LyricsPosition = (typeof LYRICS_POSITIONS)[number]

export const LYRICS_MODES = ['2d', '3d'] as const
export type LyricsMode = (typeof LYRICS_MODES)[number]

/**
 * 歌词姿态。`auto` 跟随位置：居中不转，偏右俯视 Z 顺时针，偏左俯视 Z 逆时针，底部后仰。
 */
export const LYRICS_POSES = ['auto', 'none', 'top-cw', 'top-ccw', 'tilt', 'sphere', 'free'] as const
export type LyricsPose = (typeof LYRICS_POSES)[number]

/** 歌词 3D 字体：字形在 canvas 上提取，字体必须是随应用打包的本地文件（CSP 禁止外部字体）。 */
export const LYRICS_FONTS = [
  { id: 'noto-sans', label: 'Noto Sans SC', family: 'Noto Sans SC', weight: 700 },
  { id: 'noto-serif', label: 'Noto Serif SC', family: 'Noto Serif SC', weight: 700 },
  { id: 'lxgw-wenkai', label: '霞鹜文楷', family: 'LXGW WenKai', weight: 500 },
  { id: 'zcool-kuaile', label: '站酷快乐体', family: 'ZCOOL KuaiLe', weight: 400 },
  { id: 'ma-shan-zheng', label: '马善政楷书', family: 'Ma Shan Zheng', weight: 400 },
  { id: 'long-cang', label: '龙藏手书', family: 'Long Cang', weight: 400 },
  { id: 'zhi-mang-xing', label: '志莽行书', family: 'Zhi Mang Xing', weight: 400 },
  { id: 'liu-jian-mao-cao', label: '刘建毛草', family: 'Liu Jian Mao Cao', weight: 400 },
  { id: 'zcool-xiaowei', label: '站酷小薇', family: 'ZCOOL XiaoWei', weight: 400 },
  { id: 'zcool-qingke-huangyou', label: '站酷黄油', family: 'ZCOOL QingKe HuangYou', weight: 400 }
] as const
export type LyricsFontId = (typeof LYRICS_FONTS)[number]['id'] | `user-${string}`
export interface ImportedFont {
  id: `user-${string}`
  label: string
  family: string
  weight: number
}

export interface LyricsRotation {
  /** 俯仰（绕 X），度。 */
  x: number
  /** 偏航（绕 Y），度。 */
  y: number
  /** 滚转（绕 Z），度。 */
  z: number
}

export interface AppSettings {
  onboardingComplete: boolean
  vizOffset: { x: number; y: number; z: number }
  vizZoom: number
  vizCustomOffset: boolean
  hdrEnabled: boolean
  renderGpu: string
  wallpaperEnabled: boolean
  fullscreenTime: boolean
  fullscreenDate: boolean
  wallpaperTime: boolean
  wallpaperDate: boolean
  miniCoverBackdrop: boolean
  wallpaperMouseFollow: boolean
  lyricsSize: number
  videoSignature: string
  videoCoverFont: LyricsFontId
  argbEnabled: boolean
  argbPort: number
  argbBrightness: number
  argbDevices: string[]
  renderFps: number
  renderScale: number
  renderEffects: boolean
  backgroundPlayback: boolean
  autoScan: boolean
  musicFolders: string[]
  themeMode: ThemeMode
  /** 手动强调色；关闭自动取色或没有封面时使用。 */
  accent: string
  autoAccent: boolean
  autoBackdrop: boolean
  /** 封面模糊背景的亮度，0..1。 */
  backdropBrightness: number
  autoHideControls: boolean
  sidecarLyrics: boolean
  sidecarCover: boolean
  recursiveScan: boolean
  rememberPlaylist: boolean
  lyricsVisible: boolean
  lyricsMode: LyricsMode
  lyricsShadow: boolean
  lyricsPosition: LyricsPosition
  /** 自定义位置与偏移，{x, y, z} */
  lyricsOffset: { x: number; y: number; z?: number }
  lyricsPose: LyricsPose
  lyricsRotation: LyricsRotation
  /** 球形旋转的速度，0..1。 */
  lyricsSpin: number
  lyricsFont: LyricsFontId
}

export const DEFAULT_SETTINGS: AppSettings = {
  onboardingComplete: false,
  vizOffset: { x: -450, y: 0, z: 0 },
  vizZoom: 1,
  vizCustomOffset: false,
  hdrEnabled: false,
  renderGpu: 'auto',
  wallpaperEnabled: false,
  fullscreenTime: false,
  fullscreenDate: false,
  wallpaperTime: true,
  wallpaperDate: true,
  miniCoverBackdrop: true,
  wallpaperMouseFollow: true,
  lyricsSize: 100,
  videoSignature: 'Just A Player',
  videoCoverFont: 'noto-serif',
  argbEnabled: false,
  argbPort: 6742,
  argbBrightness: 0.5,
  argbDevices: ['*'],
  renderFps: 0,
  renderScale: 1,
  renderEffects: true,
  backgroundPlayback: true,
  autoScan: true,
  musicFolders: [],
  themeMode: 'system',
  accent: DEFAULT_ACCENT,
  autoAccent: true,
  autoBackdrop: true,
  backdropBrightness: 0.4,
  autoHideControls: false,
  sidecarLyrics: true,
  sidecarCover: true,
  recursiveScan: true,
  rememberPlaylist: true,
  lyricsVisible: true,
  lyricsMode: '3d',
  lyricsShadow: true,
  lyricsPosition: 'right',
  lyricsOffset: { x: 0, y: -30, z: 0 },
  lyricsPose: 'auto',
  lyricsRotation: { x: 0, y: 0, z: 0 },
  lyricsSpin: 0.5,
  lyricsFont: 'noto-sans'
}

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const isUnit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1
const isOffset = (v: unknown): v is { x: number; y: number; z?: number } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { x?: unknown }).x === 'number' &&
  typeof (v as { y?: unknown }).y === 'number' &&
  ((v as { z?: unknown }).z === undefined || typeof (v as { z?: unknown }).z === 'number')
const isMode = (v: unknown): v is LyricsMode =>
  typeof v === 'string' && (LYRICS_MODES as readonly string[]).includes(v)
const isPosition = (v: unknown): v is LyricsPosition =>
  typeof v === 'string' && (LYRICS_POSITIONS as readonly string[]).includes(v)
const isPose = (v: unknown): v is LyricsPose =>
  typeof v === 'string' && (LYRICS_POSES as readonly string[]).includes(v)
const isAngle = (v: unknown): v is number => typeof v === 'number' && v >= -180 && v <= 180
const isRotation = (v: unknown): v is LyricsRotation =>
  typeof v === 'object' &&
  v !== null &&
  isAngle((v as { x?: unknown }).x) &&
  isAngle((v as { y?: unknown }).y) &&
  isAngle((v as { z?: unknown }).z)
const isFont = (v: unknown): v is LyricsFontId =>
  typeof v === 'string' &&
  (LYRICS_FONTS.some((font) => font.id === v) || /^user-[a-f0-9]{64}$/.test(v))

/** 把一份部分设置合并进当前设置；不合法的字段忽略，保持原值。 */
export function applySettingsPatch(base: AppSettings, patch: unknown): AppSettings {
  if (typeof patch !== 'object' || patch === null) return base
  const input = patch as Record<string, unknown>
  const next: AppSettings = { ...base }
  for (const key of ['onboardingComplete', 'vizCustomOffset', 'hdrEnabled'] as const)
    if (isBoolean(input[key])) next[key] = input[key]
  if (
    typeof input['renderGpu'] === 'string' &&
    (input['renderGpu'] === 'auto' ||
      /^[0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{8}:[0-9a-f]{2,8}:\d+$/.test(input['renderGpu']))
  )
    next.renderGpu = input['renderGpu']
  if (
    isOffset(input['vizOffset']) &&
    [input['vizOffset'].x, input['vizOffset'].y, input['vizOffset'].z ?? 0].every(
      (v) => Number.isFinite(v) && Math.abs(v) <= 10000
    )
  )
    next.vizOffset = { ...input['vizOffset'], z: input['vizOffset'].z ?? 0 }
  if (typeof input['vizZoom'] === 'number' && input['vizZoom'] >= 0.3 && input['vizZoom'] <= 3)
    next.vizZoom = input['vizZoom']
  for (const key of [
    'wallpaperEnabled',
    'fullscreenTime',
    'fullscreenDate',
    'wallpaperTime',
    'wallpaperDate'
  ] as const)
    if (isBoolean(input[key])) next[key] = input[key]
  if (isBoolean(input['miniCoverBackdrop'])) next.miniCoverBackdrop = input['miniCoverBackdrop']
  if (isBoolean(input['wallpaperMouseFollow']))
    next.wallpaperMouseFollow = input['wallpaperMouseFollow']
  if (
    typeof input['lyricsSize'] === 'number' &&
    Number.isFinite(input['lyricsSize']) &&
    input['lyricsSize'] >= 50 &&
    input['lyricsSize'] <= 200
  )
    next.lyricsSize = input['lyricsSize']
  if (typeof input['videoSignature'] === 'string')
    next.videoSignature = input['videoSignature'].slice(0, 80)
  if (isFont(input['videoCoverFont'])) next.videoCoverFont = input['videoCoverFont']
  if (isBoolean(input['argbEnabled'])) next.argbEnabled = input['argbEnabled']
  if (
    typeof input['argbPort'] === 'number' &&
    Number.isInteger(input['argbPort']) &&
    input['argbPort'] > 0 &&
    input['argbPort'] <= 65535
  )
    next.argbPort = input['argbPort']
  if (isUnit(input['argbBrightness'])) next.argbBrightness = input['argbBrightness']
  if (
    Array.isArray(input['argbDevices']) &&
    input['argbDevices'].every((v) => typeof v === 'string' && v.length < 1024)
  )
    next.argbDevices = [...new Set(input['argbDevices'] as string[])].slice(0, 128)
  if (typeof input['renderFps'] === 'number' && [0, 24, 30, 60, 120].includes(input['renderFps']))
    next.renderFps = input['renderFps']
  if (
    typeof input['renderScale'] === 'number' &&
    [0.5, 0.75, 1, 1.5, 2].includes(input['renderScale'])
  )
    next.renderScale = input['renderScale']
  if (isBoolean(input['renderEffects'])) next.renderEffects = input['renderEffects']
  if (isBoolean(input['backgroundPlayback'])) next.backgroundPlayback = input['backgroundPlayback']
  if (isBoolean(input['autoScan'])) next.autoScan = input['autoScan']
  if (
    Array.isArray(input['musicFolders']) &&
    input['musicFolders'].every((v) => typeof v === 'string')
  )
    next.musicFolders = [...new Set(input['musicFolders'] as string[])].slice(0, 64)

  if (isThemeMode(input['themeMode'])) next.themeMode = input['themeMode']
  if (isHex(input['accent'])) next.accent = input['accent'].toLowerCase()
  if (isBoolean(input['autoAccent'])) next.autoAccent = input['autoAccent']
  if (isBoolean(input['autoBackdrop'])) next.autoBackdrop = input['autoBackdrop']
  if (isUnit(input['backdropBrightness'])) next.backdropBrightness = input['backdropBrightness']
  if (isBoolean(input['autoHideControls'])) next.autoHideControls = input['autoHideControls']
  if (isBoolean(input['sidecarLyrics'])) next.sidecarLyrics = input['sidecarLyrics']
  if (isBoolean(input['sidecarCover'])) next.sidecarCover = input['sidecarCover']
  if (isBoolean(input['recursiveScan'])) next.recursiveScan = input['recursiveScan']
  if (isBoolean(input['rememberPlaylist'])) next.rememberPlaylist = input['rememberPlaylist']
  if (isBoolean(input['lyricsVisible'])) next.lyricsVisible = input['lyricsVisible']
  if (isMode(input['lyricsMode'])) next.lyricsMode = input['lyricsMode']
  if (isBoolean(input['lyricsShadow'])) next.lyricsShadow = input['lyricsShadow']
  if (isPosition(input['lyricsPosition'])) next.lyricsPosition = input['lyricsPosition']
  if (isOffset(input['lyricsOffset'])) {
    const o = input['lyricsOffset']
    next.lyricsOffset = { x: o.x, y: o.y, z: typeof o.z === 'number' ? o.z : 0 }
  }
  if (isPose(input['lyricsPose'])) next.lyricsPose = input['lyricsPose']
  if (isRotation(input['lyricsRotation'])) {
    const r = input['lyricsRotation']
    next.lyricsRotation = { x: r.x, y: r.y, z: r.z }
  }
  if (isUnit(input['lyricsSpin'])) next.lyricsSpin = input['lyricsSpin']
  if (isFont(input['lyricsFont'])) next.lyricsFont = input['lyricsFont']

  return next
}
