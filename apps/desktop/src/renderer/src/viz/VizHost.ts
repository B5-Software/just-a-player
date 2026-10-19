import * as THREE from 'three'
import { HdrPresenter } from './hdr'
import { useCover } from '../cover/store'
import { useSettings } from '../settings/store'
import { activeAccents, useTheme } from '../theme/store'
import { audio } from './audio'
import { Palette } from './palette'
import { PostStack } from './post'
import { SCENES, type VizScene } from './scenes'
import { useViz } from './store'
import { useUi } from '../ui/store'

/** 自动轮播的间隔（秒）。 */
const AUTO_CYCLE_SECONDS = 42

/**
 * 可视化宿主：持有 WebGL 渲染器与后处理，驱动当前场景，并负责场景切换的淡入淡出。
 * 封面模糊背景作为场景的 `scene.background` 纹理接入；关闭或没有封面时恢复场景自带的背景。
 * 它不依赖 React，只在 `Visualizer` 组件里创建/销毁。
 */
export class VizHost {
  private readonly hdr: HdrPresenter
  private readonly renderer: THREE.WebGLRenderer
  private readonly post: PostStack
  private readonly palette: Palette
  /** 平滑后的指针位置，交给场景；避免鼠标进出画布时镜头瞬移。 */
  private readonly pointer = new THREE.Vector2()
  /** 指针的原始目标位置，每帧向它缓动。 */
  private readonly pointerTarget = new THREE.Vector2()
  private readonly resizeObserver: ResizeObserver
  private readonly unsubscribe: Array<() => void> = []

  private current: VizScene | null = null
  private currentId = ''
  private pendingId: string | null = null
  private fade = 1
  private cycleTimer = 0
  private width = 0
  private height = 0
  private raf = 0
  private disposed = false
  private exporting = false
  renderOffline(
    frame: Float32Array,
    time: number,
    width: number,
    height: number,
    fps: number
  ): HTMLCanvasElement {
    if (!this.exporting || this.width !== width || this.height !== height) {
      this.exporting = true
      this.width = width
      this.height = height
      this.pixelRatio = 1
      this.renderer.setPixelRatio(1)
      this.renderer.setSize(width, height, false)
      this.post.setSize(width, height)
      this.current?.resize(width, height)
      this.resizePending = false
      this.hasFrame = false
      this.fade = 0
    }
    audio.offline(frame, time, 1 / fps)
    this.draw(time * 1000, true)
    return this.renderer.domElement
  }
  endOffline(): void {
    this.exporting = false
    this.resizePending = true
    this.hasFrame = false
    this.fade = 0
    audio.endOffline()
  }
  private resizePending = true
  private contextLost = false
  private hasFrame = false
  private lastDraw = -Infinity
  private pixelRatio = 1
  private lastFrame = document.createElement('canvas')
  private lastFrameContext = this.lastFrame.getContext('2d', { alpha: false })!
  private spareFrame = document.createElement('canvas')
  get presentedFrame(): HTMLCanvasElement {
    return this.lastFrame
  }
  mirrorHDR(presenter: HdrPresenter): boolean {
    return presenter.mirror(this.hdr, this.renderer.domElement)
  }
  frameVersion = 0
  lastRenderError: string | null = null
  private readonly sample = document.createElement('canvas')
  private readonly sampleContext = this.sample.getContext('2d', { willReadFrequently: true })!
  rejectedFrames = 0
  private readonly placeholder = new THREE.Scene()
  private readonly placeholderCamera = new THREE.PerspectiveCamera()
  /** 当前场景自带的背景（纯色或纹理），取消封面背景时恢复它。 */
  private defaultBackground: THREE.Scene['background'] = null
  private backdropCanvas: HTMLCanvasElement | null = null
  private backdropTexture: THREE.CanvasTexture | null = null
  private readonly backdropMix = document.createElement('canvas')
  private readonly backdropFrom = document.createElement('canvas')
  private backdropBlend = 1

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    })
    this.pixelRatio = window.devicePixelRatio * useSettings.getState().renderScale
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    const canvas = this.renderer.domElement
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;'
    this.lastFrame.style.cssText = canvas.style.cssText
    this.lastFrame.setAttribute('aria-hidden', 'true')
    // Keep the mutable WebGL drawing buffer out of the compositor. Only a
    // completed, validated image is presented (HDR has its own GPU presenter).
    host.appendChild(this.lastFrame)
    this.hdr = new HdrPresenter(host)
    canvas.style.pointerEvents = 'none'
    this.sample.width = 16
    this.sample.height = 9
    this.lastFrame.width = 480
    this.lastFrame.height = 270
    const initial = this.lastFrameContext.createLinearGradient(0, 0, 480, 270)
    initial.addColorStop(0, '#18152c')
    initial.addColorStop(1, '#090c17')
    this.lastFrameContext.fillStyle = initial
    this.lastFrameContext.fillRect(0, 0, 480, 270)
    this.backdropMix.width = this.backdropFrom.width = 480
    this.backdropMix.height = this.backdropFrom.height = 270
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    const accents = activeAccents()
    this.palette = new Palette(accents.primary, accents.secondary)
    const syncAccent = (): void => {
      const next = activeAccents()
      this.palette.update(next.primary, next.secondary)
    }
    this.unsubscribe.push(useTheme.subscribe(syncAccent))
    this.unsubscribe.push(
      useCover.subscribe(() => {
        syncAccent()
        this.syncBackdrop()
      })
    )
    this.unsubscribe.push(
      useSettings.subscribe(() => {
        syncAccent()
        this.applyBackground()
        this.resizePending = true
      })
    )

    this.post = new PostStack(this.renderer, this.placeholder, this.placeholderCamera)

    this.setScene(useViz.getState().sceneId)
    let lastId = useViz.getState().sceneId
    this.unsubscribe.push(
      useViz.subscribe((state) => {
        if (state.sceneId !== lastId) {
          lastId = state.sceneId
          this.setScene(state.sceneId)
        }
      })
    )

    // 监听整个窗口：鼠标移到悬浮控件上时不会误触发 leave，镜头也就不会跳
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('blur', this.onPointerReset)
    this.unsubscribe.push(window.jap.onWallpaperPointer(({ x, y }) => this.pointerTarget.set(x, y)))

    // 自由移动与缩放 3D 可视化
    host.addEventListener('pointerdown', this.onStagePointerDown)
    window.addEventListener('pointermove', this.onStagePointerMove)
    window.addEventListener('pointerup', this.onStagePointerUp)
    host.addEventListener('wheel', this.onStageWheel, { passive: true })
    host.addEventListener('dblclick', this.onStageDblClick)

    // ResizeObserver runs after rAF. Resizing here would clear the drawing buffer
    // after rendering and present a black frame. Resize and draw in the same rAF.
    this.resizeObserver = new ResizeObserver(() => {
      this.resizePending = true
    })
    this.resizeObserver.observe(host)
    this.resize()
    this.syncBackdrop()

    this.raf = requestAnimationFrame(this.frame)
  }

  private isDragging = false
  private dragStart = { x: 0, y: 0 }
  private initialOffset = { x: 0, y: 0 }
  private curOffset = { x: -450, y: 0 }

  private setScene(id: string): void {
    if (id === this.currentId && this.pendingId === null) return
    this.pendingId = id
  }

  private swapScene(id: string): void {
    const def = SCENES.find((s) => s.id === id) ?? SCENES[0]!
    try {
      const next = def.create()
      next.resize(this.width, this.height)
      this.renderer.compile(next.scene, next.camera)
      if (this.current && this.hasFrame) this.post.capture()
      const previous = this.current
      this.current = next
      this.fade = previous && this.hasFrame ? 1 : 0
      this.defaultBackground = this.current.scene.background
      this.currentId = def.id
      this.applyBackground()
      previous?.dispose()
    } catch (error) {
      console.error(`[viz] 场景 ${def.id} 创建失败`, error)
    }
    this.pendingId = null
    this.cycleTimer = 0
  }

  /** 封面纹理换了：重建 GPU 纹理，并更新当前场景的背景。 */
  private syncBackdrop(): void {
    const canvas = useCover.getState().backdrop
    if (canvas === this.backdropCanvas) {
      this.applyBackground()
      return
    }
    this.backdropFrom.getContext('2d')!.drawImage(this.backdropMix, 0, 0)
    this.backdropCanvas = canvas
    this.backdropBlend = 0
    if (!this.backdropTexture) {
      const texture = new THREE.CanvasTexture(this.backdropMix)
      texture.colorSpace = THREE.SRGBColorSpace
      this.backdropTexture = texture
    }
    this.updateBackdrop(0)
    this.applyBackground()
  }
  private updateBackdrop(dt: number): void {
    if (!this.backdropTexture) return
    const c = this.backdropMix.getContext('2d')!
    const was = this.backdropBlend
    this.backdropBlend = Math.min(1, this.backdropBlend + dt / 0.85)
    if (was === 1 && dt > 0) return
    c.globalAlpha = 1
    c.fillStyle =
      this.defaultBackground instanceof THREE.Color ? this.defaultBackground.getStyle() : '#0c0b14'
    c.fillRect(0, 0, 480, 270)
    if (this.backdropBlend < 1) c.drawImage(this.backdropFrom, 0, 0)
    if (this.backdropCanvas) {
      c.globalAlpha = this.backdropBlend
      c.drawImage(this.backdropCanvas, 0, 0, 480, 270)
    } else {
      c.globalAlpha = this.backdropBlend
      c.fillRect(0, 0, 480, 270)
    }
    c.globalAlpha = 1
    this.backdropTexture.needsUpdate = true
    this.applyBackground()
  }

  private applyBackground(): void {
    const scene = this.current
    if (!scene) return
    const { autoBackdrop, backdropBrightness } = useSettings.getState()
    const texture = autoBackdrop ? this.backdropTexture : null
    scene.scene.background = texture ?? this.defaultBackground
    // 纹理背景的亮度由 backgroundIntensity 控制，拖动滑块时即时生效
    scene.scene.backgroundIntensity = backdropBrightness
    scene.setBackdrop?.(texture, backdropBrightness)
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.host
    this.resizePending = false
    const pixelRatio = window.devicePixelRatio * useSettings.getState().renderScale
    if (
      w === 0 ||
      h === 0 ||
      (w === this.width && h === this.height && pixelRatio === this.pixelRatio)
    )
      return
    this.pixelRatio = pixelRatio
    this.renderer.setPixelRatio(pixelRatio)
    this.width = w
    this.height = h
    this.hasFrame = false
    this.renderer.setSize(w, h, false)
    this.post.setSize(w, h)
    this.current?.resize(w, h)
    this.fade = 0
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault()
    this.contextLost = true
    // Show the cached image while the GPU context is being recovered.
    this.renderer.domElement.style.visibility = 'hidden'
  }

  private readonly onContextRestored = (): void => {
    this.hdr.invalidate()
    this.contextLost = false
    this.hasFrame = false
    this.resizePending = true
    this.fade = 0
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.host.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1)
    // 跑到画布外就让目标回到中心，靠缓动滑回去而不是硬跳
    if (x < -1 || x > 1 || y < -1 || y > 1) this.pointerTarget.set(0, 0)
    else this.pointerTarget.set(x, y)
  }

  private readonly onPointerReset = (): void => {
    this.pointerTarget.set(0, 0)
  }

  private readonly onStagePointerDown = (e: PointerEvent): void => {
    if (useUi.getState().lyricsAdjusting) return
    this.isDragging = true
    this.dragStart = { x: e.clientX, y: e.clientY }
    this.initialOffset = { ...useViz.getState().offset }
    this.host.setPointerCapture(e.pointerId)
    this.host.style.cursor = 'grabbing'
  }

  private readonly onStagePointerMove = (e: PointerEvent): void => {
    if (!this.isDragging) return
    const dx = e.clientX - this.dragStart.x
    const dy = e.clientY - this.dragStart.y
    useViz.getState().setOffset({
      x: Math.round(this.initialOffset.x + dx),
      y: Math.round(this.initialOffset.y + dy)
    })
  }

  private readonly onStagePointerUp = (e: PointerEvent): void => {
    if (!this.isDragging) return
    this.isDragging = false
    this.host.style.cursor = ''
    try {
      if (this.host.hasPointerCapture(e.pointerId)) {
        this.host.releasePointerCapture(e.pointerId)
      }
    } catch {}
  }

  private readonly onStageWheel = (e: WheelEvent): void => {
    if (useUi.getState().lyricsAdjusting) return
    const factor = e.deltaY < 0 ? 1.05 : 0.95
    useViz.getState().setZoom((z) => Math.max(0.3, Math.min(3.0, Number((z * factor).toFixed(3)))))
  }

  private readonly onStageDblClick = (): void => {
    useViz.getState().resetPosition()
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.frame)
    if (this.exporting) return
    try {
      this.draw(now)
    } catch (error) {
      const message = String(error)
      if (message !== this.lastRenderError) console.warn('[viz] 保留上一帧：', error)
      this.lastRenderError = message
      this.renderer.domElement.style.visibility = 'hidden'
    }
  }
  private draw(now: number, offline = false): void {
    if (
      (!offline &&
        ((document.hidden && document.documentElement.dataset['windowMode'] !== 'wallpaper') ||
          document.documentElement.dataset['renderSuspended'] === '1' ||
          document.documentElement.dataset['windowMode'] === 'mini')) ||
      this.contextLost
    )
      return
    const settings = useSettings.getState()
    if (
      !offline &&
      settings.renderFps > 0 &&
      now - this.lastDraw < 1000 / settings.renderFps - 0.5 &&
      !this.resizePending
    )
      return
    this.lastDraw = now
    if (this.resizePending && !offline) this.resize()
    if (this.width === 0) return
    this.hdr.configure(this.renderer, window.jap.surface === 'main', offline)

    const state = audio.step(now)
    const dt = state.dt
    this.palette.step(dt)
    this.updateBackdrop(dt)

    const store = useViz.getState()
    if (store.auto && state.active > 0.5) {
      this.cycleTimer += dt
      if (this.cycleTimer > AUTO_CYCLE_SECONDS) {
        this.cycleTimer = 0
        store.step(1)
      }
    }

    this.fade = Math.max(0, this.fade - dt / 0.65)
    if (this.pendingId !== null) {
      this.swapScene(this.pendingId)
    }

    const scene = this.current
    if (!scene) return

    // 指针缓动到目标位置：鼠标进出画布时镜头平滑过渡，不会瞬移
    this.pointer.lerp(this.pointerTarget, 1 - Math.exp(-dt * 4))
    scene.update(state, this.palette, { pointer: this.pointer })

    // 自由移动与缩放相机视角（平滑平移）
    const { offset, zoom } = useViz.getState()
    const camera = scene.camera
    const kOffset = 1 - Math.exp(-dt * 7)
    if (this.isDragging) {
      this.curOffset.x = offset.x
      this.curOffset.y = offset.y
    } else {
      this.curOffset.x += (offset.x - this.curOffset.x) * kOffset
      this.curOffset.y += (offset.y - this.curOffset.y) * kOffset
    }
    const offX = Math.round(this.curOffset.x)
    const offY = Math.round(this.curOffset.y)
    if (!scene.instrument && (offX !== 0 || offY !== 0)) {
      camera.setViewOffset(this.width, this.height, -offX, -offY, this.width, this.height)
    } else if (camera.view !== null) {
      camera.clearViewOffset()
    }
    const targetZoom = scene.instrument ? 1 : zoom
    if (camera.zoom !== targetZoom) {
      camera.zoom = targetZoom
      camera.updateProjectionMatrix()
    }

    const k = 1 - Math.exp(-dt * 4)
    const bloom = this.post.bloom
    bloom.enabled = !scene.instrument && settings.renderEffects
    bloom.strength += (scene.bloom.strength - bloom.strength) * k
    bloom.radius += (scene.bloom.radius - bloom.radius) * k
    bloom.threshold += (scene.bloom.threshold - bloom.threshold) * k

    this.post.render(scene.scene, scene.camera, {
      time: state.time,
      beat: state.beat,
      fade: this.fade,
      dt,
      clean: scene.instrument || !settings.renderEffects
    })
    this.hasFrame = true
    this.renderer.domElement.style.visibility = 'visible'
    if (!offline) {
      // Take the float snapshot before any 8-bit 2D consumer requests an SDR
      // snapshot of this canvas. Invalid frames are hidden before presentation.
      if (this.hdr.active) this.hdr.present(this.renderer.domElement)
      // Present only a validated frame. The compositor always has an opaque
      // previous image during stalls, resize, context recovery and bad frames.
      this.sampleContext.drawImage(this.renderer.domElement, 0, 0, 16, 9)
      const bytes = this.sampleContext.getImageData(0, 0, 16, 9).data
      let peak = 0
      for (let i = 0; i < bytes.length; i += 4)
        peak = Math.max(peak, bytes[i]!, bytes[i + 1]!, bytes[i + 2]!)
      // Silent instruments and dark starfields are valid. Reject a cleared/NaN
      // image, not a deliberately dark scene (which would stall hand-offs).
      if (peak < 3) {
        this.rejectedFrames++
        this.hdr.hide()
        this.renderer.domElement.style.visibility = 'hidden'
        return
      }
      const width = this.renderer.domElement.width
      const height = this.renderer.domElement.height
      if (this.lastFrame.width !== width || this.lastFrame.height !== height) {
        // Resizing an attached canvas immediately clears its compositor layer.
        // Build the replacement off-DOM, then exchange it without an empty frame.
        const next = this.spareFrame
        next.width = width
        next.height = height
        next.style.cssText = this.lastFrame.style.cssText
        next.setAttribute('aria-hidden', 'true')
        const context = next.getContext('2d', { alpha: false })!
        context.drawImage(this.renderer.domElement, 0, 0, width, height)
        this.lastFrame.replaceWith(next)
        this.spareFrame = this.lastFrame
        this.lastFrame = next
        this.lastFrameContext = context
      } else {
        this.lastFrameContext.drawImage(this.renderer.domElement, 0, 0, width, height)
      }
      this.lastRenderError = null
      this.frameVersion++
    }
  }

  dispose(): void {
    this.hdr.dispose()
    this.disposed = true
    cancelAnimationFrame(this.raf)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('blur', this.onPointerReset)
    this.host.removeEventListener('pointerdown', this.onStagePointerDown)
    window.removeEventListener('pointermove', this.onStagePointerMove)
    window.removeEventListener('pointerup', this.onStagePointerUp)
    this.host.removeEventListener('wheel', this.onStageWheel)
    this.host.removeEventListener('dblclick', this.onStageDblClick)
    this.resizeObserver.disconnect()
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost)
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored)
    this.unsubscribe.forEach((fn) => fn())
    this.current?.dispose()
    this.backdropTexture?.dispose()
    this.post.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
    this.lastFrame.remove()
  }
}
