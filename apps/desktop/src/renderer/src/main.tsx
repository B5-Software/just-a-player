// 字体与主题模块必须最先导入：主题会在 React 渲染前给 <html> 设好深浅色与强调色
import './fonts/fonts.css'
import './theme/store'
import './engine/store'
import './audio/dsp-store'
import './audio/quality-store'
import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { usePlayer } from './engine/store'
import { addAudioPaths } from './library/actions'
import { initLibrary } from './library'
import { initScanner } from './library/scanner'
import { playItem, playNeighbour, playPrevious, playDefaultOrResume } from './library/playback'
import { useLibrary } from './library/store'
import { useCover } from './cover/store'
import { useLyrics } from './lyrics/store'
import { useSettings } from './settings/store'
import { useUi } from './ui/store'
import { useViz } from './viz/store'
import { useDsp } from './audio/dsp-store'
import { useQuality } from './audio/quality-store'
import { exportVideo, useVideoExport, useVideoQueue } from './video/export'
import { WallpaperApp, WallpaperFallback } from './WallpaperApp'
import { GraphicsBoundary } from './components/GraphicsBoundary'
import { TrayApp } from './TrayApp'
import { ExportApp } from './ExportApp'
import { engine } from './engine/client'
import { loadCover } from './cover/store'
import { loadLyrics } from './lyrics/store'
import { initSystemMediaSync } from './engine/system-media'
import { useFontCatalog } from './fonts/catalog'
import { metadataOpacity, createCoverCard } from './video/cover-card'
import { useHdr } from './viz/hdr'

const surface = window.jap.surface
document.documentElement.dataset['surface'] = surface
if (surface === 'main') {
  initScanner()
  initLibrary()
  initSystemMediaSync()
  const syncVisual = (): void => {
    const s = useViz.getState()
    window.jap.syncVisual({
      sceneId: s.sceneId,
      auto: s.auto,
      zoom: s.zoom,
      offset: s.offset,
      lyricsText: useLyrics.getState().text
    })
  }
  useViz.subscribe(syncVisual)
  useLyrics.subscribe(syncVisual)
  syncVisual()
} else if (surface === 'wallpaper') {
  document.documentElement.dataset['windowMode'] = 'wallpaper'
  document.documentElement.dataset['renderSuspended'] = '1'
  engine.onEvent((event) => {
    if (event.type === 'trackChanged') {
      void loadCover(event.track.path)
      void loadLyrics(event.track.path)
    }
  })
} else if (surface === 'export') {
  document.documentElement.dataset['renderSuspended'] = '1'
} else {
  document.documentElement.style.background = 'transparent'
}
window.jap.onVisibility((visible) => {
  document.documentElement.dataset['renderSuspended'] = visible ? '' : '1'
})
window.jap.onMediaCommand((command) => {
  if (command === 'toggle') playDefaultOrResume()
  else if (command === 'next') playNeighbour(1)
  else if (command === 'previous') playPrevious()
  else if (command === 'stop') usePlayer.getState().stop()
  else if (command === 'reset') usePlayer.getState().resetBuffer()
  else if (command === 'play' && usePlayer.getState().state !== 'playing') playDefaultOrResume()
  else if (command === 'pause' && usePlayer.getState().state === 'playing')
    usePlayer.getState().togglePause()
})
if (surface === 'main' && !navigator.userAgent.includes('Windows') && 'mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => {
    if (usePlayer.getState().state !== 'playing') playDefaultOrResume()
  })
  navigator.mediaSession.setActionHandler('pause', () => {
    if (usePlayer.getState().state === 'playing') usePlayer.getState().togglePause()
  })
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    playNeighbour(1)
  })
  navigator.mediaSession.setActionHandler('previoustrack', playPrevious)
  usePlayer.subscribe((state, prev) => {
    if (state.track !== prev.track && state.track)
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.track.title ?? state.track.path.split(/[\\/]/).pop(),
        artist: state.track.artist ?? '',
        album: state.track.album ?? ''
      })
    if (state.state !== prev.state)
      navigator.mediaSession.playbackState =
        state.state === 'playing' ? 'playing' : state.state === 'paused' ? 'paused' : 'none'
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {surface === 'wallpaper' ? (
      <GraphicsBoundary fallback={() => <WallpaperFallback />}>
        <WallpaperApp />
      </GraphicsBoundary>
    ) : surface === 'tray' ? (
      <TrayApp />
    ) : surface === 'export' ? (
      <ExportApp />
    ) : (
      <App />
    )}
  </StrictMode>
)

// 端到端截图脚本通过 ?e2e=1 打开该钩子来驱动界面
if (new URLSearchParams(location.search).has('e2e')) {
  ;(window as unknown as Record<string, unknown>)['__jap'] = {
    exportVideo,
    useVideoExport,
    useVideoQueue,
    useHdr,
    usePlayer,
    useDsp,
    useQuality,
    useViz,
    useLibrary,
    useCover,
    useLyrics,
    useSettings,
    useUi,
    addAudioPaths,
    playItem,
    useFontCatalog,
    metadataOpacity,
    createCoverCard
  }
}
