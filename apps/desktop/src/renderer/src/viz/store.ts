import { create } from 'zustand'
import { useLyrics } from '../lyrics/store'
import { useSettings } from '../settings/store'
import { SCENES, useSceneRegistry } from './scenes'

const SCENE_KEY = 'jap.viz.scene'
const AUTO_KEY = 'jap.viz.auto'
const lyricsOffsetX = (): number =>
  window.jap.platform === 'android' ? -Math.min(450, innerWidth * 0.25) : -450

function initialScene(): string {
  const stored = localStorage.getItem(SCENE_KEY)
  return SCENES.some((s) => s.id === stored) ? stored! : SCENES[0]!.id
}

interface VizStore {
  sceneId: string
  /** 自动轮播场景。 */
  auto: boolean
  fullscreen: boolean
  /** 3D 可视化自由移动的像素偏移 {x, y, z} */
  offset: { x: number; y: number; z: number }
  /** 用户是否手动指定了偏移 */
  userCustomOffset: boolean
  /** 3D 可视化缩放倍率 */
  zoom: number
  setScene: (id: string) => void
  step: (delta: 1 | -1) => void
  setAuto: (auto: boolean) => void
  setFullscreen: (fullscreen: boolean) => void
  setOffset: (
    offset:
      | { x: number; y: number; z?: number }
      | ((prev: { x: number; y: number; z: number }) => { x: number; y: number; z?: number })
  ) => void
  setZoom: (zoom: number | ((prev: number) => number)) => void
  resetPosition: () => void
  syncAutoLyricsOffset: (hasLyrics: boolean) => void
}

export const useViz = create<VizStore>((set, get) => ({
  sceneId: initialScene(),
  auto: localStorage.getItem(AUTO_KEY) === '1',
  fullscreen: false,
  offset: useSettings.getState().vizOffset,
  userCustomOffset: useSettings.getState().vizCustomOffset,
  zoom: useSettings.getState().vizZoom,

  setScene: (id) => {
    if (!SCENES.some((s) => s.id === id)) id = SCENES[0]!.id
    if (window.jap.surface === 'main') localStorage.setItem(SCENE_KEY, id)
    set({ sceneId: id })
  },
  step: (delta) => {
    const index = SCENES.findIndex((s) => s.id === get().sceneId)
    const next = SCENES[(index + delta + SCENES.length) % SCENES.length]!
    get().setScene(next.id)
  },
  setAuto: (auto) => {
    if (window.jap.surface === 'main') localStorage.setItem(AUTO_KEY, auto ? '1' : '0')
    set({ auto })
  },
  setFullscreen: (fullscreen) => {
    syncFullscreen(fullscreen)
    void window.jap.setFullscreen(fullscreen)
  },
  setOffset: (offset) => {
    set((state) => {
      const next = typeof offset === 'function' ? offset(state.offset) : offset
      return {
        userCustomOffset: true,
        offset: { x: next.x, y: next.y, z: next.z ?? 0 },
      }
    })
  },
  setZoom: (zoom) => {
    set((state) => ({
      zoom: typeof zoom === 'function' ? zoom(state.zoom) : zoom,
    }))
  },
  resetPosition: () => {
    const hasLyrics = Boolean(useLyrics.getState().text && useSettings.getState().lyricsVisible)
    set({
      userCustomOffset: false,
      offset: { x: hasLyrics ? lyricsOffsetX() : 0, y: 0, z: 0 },
      zoom: 1,
    })
  },
  syncAutoLyricsOffset: (hasLyrics: boolean) => {
    if (window.jap.surface === 'export') return
    if (get().userCustomOffset) return
    const targetX = hasLyrics ? lyricsOffsetX() : 0
    if (get().offset.x === targetX && get().offset.y === 0 && get().offset.z === 0) return
    set({ offset: { x: targetX, y: 0, z: 0 } })
  },
}))
useSceneRegistry.subscribe(() => {
  const v = useViz.getState()
  if (!SCENES.some((s) => s.id === v.sceneId)) v.setScene(SCENES[0]!.id)
})

// 监听歌词变化：有歌词时默认将 3D 可视化左移 -450px 给右侧歌词留出舒适空间
const syncLyricsOffset = (): void => {
  const hasLyrics = Boolean(useLyrics.getState().text && useSettings.getState().lyricsVisible)
  useViz.getState().syncAutoLyricsOffset(hasLyrics)
}
useLyrics.subscribe(syncLyricsOffset)
useSettings.subscribe(syncLyricsOffset)
if (window.jap.platform === 'android') window.addEventListener('resize', syncLyricsOffset)

/** 只同步状态、不再回调主进程，避免和窗口事件来回打架。 */
function syncFullscreen(fullscreen: boolean): void {
  useViz.setState({ fullscreen })
}

// 主进程是窗口全屏状态的唯一真相来源
window.jap.onFullscreenChange(syncFullscreen)

if (window.jap.surface === 'main') {
  let save: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    const v = useViz.getState()
    useSettings
      .getState()
      .update({ vizOffset: v.offset, vizZoom: v.zoom, vizCustomOffset: v.userCustomOffset })
  }
  useViz.subscribe((v, old) => {
    if (
      v.zoom === old.zoom &&
      v.userCustomOffset === old.userCustomOffset &&
      v.offset.x === old.offset.x &&
      v.offset.y === old.offset.y &&
      v.offset.z === old.offset.z
    )
      return
    clearTimeout(save)
    save = setTimeout(persist, 400)
  })
  window.addEventListener('beforeunload', persist)
}
