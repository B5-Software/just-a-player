import { create } from 'zustand'
import { useEffect, useRef, useState } from 'react'
import { Visualizer, activeVizHost } from './components/Visualizer'
import { LyricsLayer, activeLyricsRenderer } from './lyrics/LyricsLayer'
import { Lyrics2D } from './lyrics/Lyrics2D'
import { ClockOverlay } from './components/ClockOverlay'
import type { WallpaperState, WallpaperLayout } from '@shared/desktop'
import { useViz } from './viz/store'
import { useLyrics } from './lyrics/store'
import { useSettings } from './settings/store'
import { HdrPresenter } from './viz/hdr'
import { livePositionMs } from './engine/clock'
import { CoverBackdrop } from './components/GraphicsBoundary'
import { useCover } from './cover/store'

const useWallpaper = create<WallpaperState>(() => ({ live: false, snapshot: null, token: 0 }))
if (window.jap.surface === 'wallpaper') {
  // Acknowledge only after every monitor has a completed presentation image.
  window.jap.onWallpaperState((next) => useWallpaper.setState(next))
  window.jap.onVisualSync((value) => {
    if (!value || typeof value !== 'object') return
    const v = value as {
      sceneId: string
      auto: boolean
      zoom: number
      offset: { x: number; y: number; z: number }
      lyricsText?: string | null
    }
    useViz.setState({
      sceneId: v.sceneId,
      auto: v.auto,
      zoom: v.zoom,
      offset: v.offset,
      userCustomOffset: true
    })
    if (v.lyricsText !== undefined) useLyrics.setState({ text: v.lyricsText })
  })
}

interface Mirror {
  scene: HTMLCanvasElement
  lyrics: HTMLCanvasElement
  hdrScene: HdrPresenter
  hdrLyrics: HdrPresenter
}

function Display({
  display,
  layout,
  frozen,
  register
}: {
  display: WallpaperLayout['displays'][number]
  layout: WallpaperLayout
  frozen: number | null
  register: (id: number, mirror: Mirror | null) => void
}): React.JSX.Element {
  const sceneHost = useRef<HTMLDivElement>(null),
    lyricsHost = useRef<HTMLDivElement>(null)
  const lyricsMode = useSettings((s) => s.lyricsMode)
  useEffect(() => {
    const scene = document.createElement('canvas'),
      lyrics = document.createElement('canvas')
    for (const c of [scene, lyrics])
      c.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;visibility:hidden'
    // Portrait displays crop the scenery, but keep the whole lyric composition.
    lyrics.style.objectFit = 'contain'
    sceneHost.current!.appendChild(scene)
    lyricsHost.current!.appendChild(lyrics)
    const hdrScene = new HdrPresenter(sceneHost.current!),
      hdrLyrics = new HdrPresenter(lyricsHost.current!, true)
    hdrScene.canvas.style.objectFit = 'cover'
    hdrLyrics.canvas.style.objectFit = 'contain'
    register(display.id, { scene, lyrics, hdrScene, hdrLyrics })
    return () => {
      register(display.id, null)
      hdrScene.dispose()
      hdrLyrics.dispose()
      scene.remove()
      lyrics.remove()
    }
  }, [display.id, register])
  return (
    <section
      data-wallpaper-display={display.id}
      className="absolute overflow-hidden"
      style={{
        left: `${(display.x / layout.width) * 100}%`,
        top: `${(display.y / layout.height) * 100}%`,
        width: `${(display.width / layout.width) * 100}%`,
        height: `${(display.height / layout.height) * 100}%`,
        background: 'linear-gradient(135deg,#18152c,#090c17)'
      }}
    >
      <div
        data-wallpaper-snapshot
        className="absolute -inset-6"
        style={{
          filter: frozen === null ? 'blur(0px) brightness(1)' : 'blur(18px) brightness(.75)',
          transition: 'filter 850ms ease'
        }}
      >
        <div ref={sceneHost} className="absolute inset-0" />
        <div ref={lyricsHost} className="absolute inset-0 z-[2]" />
        {lyricsMode === '2d' && <Lyrics2D frozenTime={frozen} />}
      </div>
      <ClockOverlay wallpaper />
    </section>
  )
}

export function WallpaperApp(): React.JSX.Element {
  const wall = useWallpaper()
  const [frozen, setFrozen] = useState<number | null>(null)
  const mirrors = useRef(new Map<number, Mirror>())
  useEffect(() => {
    if (new URLSearchParams(location.search).has('e2e'))
      (window as unknown as Record<string, unknown>)['__japWallpaperMirrors'] = mirrors.current
  }, [])
  const register = useRef((id: number, mirror: Mirror | null): void => {
    if (mirror) mirrors.current.set(id, mirror)
    else mirrors.current.delete(id)
  }).current
  const layout = wall.layout ?? {
    width: 1,
    height: 1,
    displays: [{ id: 0, x: 0, y: 0, width: 1, height: 1 }]
  }
  const reference = layout.displays[0]!
  useEffect(() => {
    if (!wall.token) return
    let raf = 0,
      cancelled = false,
      accepted = false,
      copiedVersion = -1
    const version = activeVizHost?.frameVersion ?? 0
    // Warm up one frame before unblurring/freezing. Retained canvases avoid
    // screenshots of UI, async image decoding and empty hand-off frames.
    document.documentElement.dataset['renderSuspended'] = ''
    const draw = (): void => {
      if (cancelled) return
      const viz = activeVizHost
      if (!viz || viz.frameVersion <= version || mirrors.current.size !== layout.displays.length) {
        raf = requestAnimationFrame(draw)
        return
      }
      if (copiedVersion !== viz.frameVersion) {
        copiedVersion = viz.frameVersion
        const source = viz.presentedFrame,
          lyric = activeLyricsRenderer?.presentedFrame
        for (const mirror of mirrors.current.values()) {
          const w = source.width,
            h = source.height
          // A resized presentation canvas is prepared before replacing the old one.
          for (const [key, input] of [
            ['scene', source],
            ['lyrics', lyric]
          ] as const) {
            let output = mirror[key]
            if (output.width !== w || output.height !== h) {
              const next = document.createElement('canvas')
              next.width = w
              next.height = h
              next.style.cssText = output.style.cssText
              const c = next.getContext('2d', { alpha: key === 'lyrics' })!
              if (input && !input.hidden) c.drawImage(input, 0, 0, w, h)
              output.replaceWith(next)
              mirror[key] = output = next
            } else {
              const c = output.getContext('2d')!
              if (key === 'lyrics') c.clearRect(0, 0, w, h)
              if (input && !input.hidden) c.drawImage(input, 0, 0, w, h)
            }
            output.style.visibility = 'visible'
          }
          viz.mirrorHDR(mirror.hdrScene)
          if (lyric && !lyric.hidden) activeLyricsRenderer?.mirrorHDR(mirror.hdrLyrics)
          else mirror.hdrLyrics.hide()
        }
      }
      if (!accepted) {
        accepted = true
        setFrozen(wall.live ? null : livePositionMs())
        // Commit the filter and image before pausing the only scene renderer.
        raf = requestAnimationFrame(() => {
          if (cancelled) return
          document.documentElement.dataset['renderSuspended'] = wall.live ? '' : '1'
          window.jap.wallpaperReady(wall.token)
          if (wall.live) raf = requestAnimationFrame(draw)
        })
      } else if (wall.live) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [wall.token, wall.live, wall.layout])
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#18152c]">
      {/* Render each scene/3D lyric once. Copy it to each physical screen. */}
      <div
        data-wallpaper-source
        className="pointer-events-none absolute opacity-0"
        style={{
          width: `${(reference.width / layout.width) * 100}%`,
          height: `${(reference.height / layout.height) * 100}%`
        }}
      >
        <Visualizer />
        <LyricsLayer />
      </div>
      {layout.displays.map((display) => (
        <Display
          key={display.id}
          display={display}
          layout={layout}
          frozen={frozen}
          register={register}
        />
      ))}
    </div>
  )
}

/** Without a GPU, keep every monitor covered and acknowledge the normal hand-off. */
export function WallpaperFallback(): React.JSX.Element {
  const wall = useWallpaper(),
    art = useCover((state) => state.art)
  const [frozen, setFrozen] = useState<number | null>(null)
  const layout = wall.layout ?? {
    width: 1,
    height: 1,
    displays: [{ id: 0, x: 0, y: 0, width: 1, height: 1 }]
  }
  useEffect(() => {
    setFrozen(wall.live ? null : livePositionMs())
    document.documentElement.dataset['renderSuspended'] = wall.live ? '' : '1'
    let cancelled = false,
      frame = 0
    void (async () => {
      if (art) {
        const image = new Image()
        image.src = art.url
        await image.decode().catch(() => {})
      }
      if (!cancelled)
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (!cancelled && wall.token) window.jap.wallpaperReady(wall.token)
          })
        })
    })()
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [wall.token, wall.live, art])
  return (
    <div data-wallpaper-fallback className="absolute inset-0 overflow-hidden bg-[#312b52]">
      {layout.displays.map((display) => (
        <section
          key={display.id}
          data-wallpaper-display={display.id}
          className="absolute overflow-hidden"
          style={{
            left: `${(display.x / layout.width) * 100}%`,
            top: `${(display.y / layout.height) * 100}%`,
            width: `${(display.width / layout.width) * 100}%`,
            height: `${(display.height / layout.height) * 100}%`
          }}
        >
          <div
            className="absolute -inset-6"
            style={{
              filter: frozen === null ? 'blur(0px) brightness(1)' : 'blur(18px) brightness(.75)',
              transition: 'filter 850ms ease'
            }}
          >
            <CoverBackdrop />
            <Lyrics2D frozenTime={frozen} />
          </div>
          <ClockOverlay wallpaper />
        </section>
      ))}
    </div>
  )
}
