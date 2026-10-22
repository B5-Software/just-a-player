import { surfacePixelRatio } from '../lib/pixel-ratio'
import * as THREE from 'three'
import { HdrPresenter } from '../viz/hdr'
import type { LyricsFontId, LyricsPose, LyricsPosition, LyricsRotation } from '@shared/settings'
import { LYRICS_FONTS } from '@shared/settings'
import { ensureFont, fontOf } from '../fonts/catalog'
import { livePositionMs } from '../engine/clock'
import { useSettings } from '../settings/store'
import { glyphShapes, type GlyphShapes } from './glyph'
import { parseLRC, wordProgress, type LyricLine } from './parse'
import { resolvePose, type PoseTarget } from './pose'

export interface LyricsStyle {
  visible: boolean
  font: LyricsFontId
  position: LyricsPosition
  offset: { x: number; y: number; z?: number }
  pose: LyricsPose
  rotation: LyricsRotation
  spin: number
  active: string
  inactive: string
  shadow: boolean
  size: number
}

interface Built {
  grp: THREE.Group
  mat: THREE.MeshStandardMaterial
  shadowMat: THREE.MeshBasicMaterial
  subMat: THREE.MeshStandardMaterial
  w: number
  cut: { value: number }
  karaoke: { value: number }
  words: { t: number; end: number; x0: number; x1: number }[]
}

interface Line extends LyricLine {
  o: Built | null
}

const FOV = 50
const DIST = 5.5
const SIZE = 0.42
const DEPTH = 0.045
const BEVEL = 0.008
const SPACING = 0.8
const CURVE = 0.12
const SUB_SCALE = 0.5
const GLOW = 0.6
const EMISSIVE_BASE = 0.3
const METAL = 0.2
const ROUGH = 0.35
const SPEED = 5
const INACTIVE_SCALE = 0.75
const RANGE = 4
const POP = 0.5
const FOLLOW = 6
const POSITION_OFFSET = { side: 0.5, bottom: 0.3 }
/** 文本可占的视口宽度比例：侧边不越过画面中线，居中与底部可以更宽。 */
const SIDE_BUDGET = 0.42
const WIDE_BUDGET = 0.9
const DEG = Math.PI / 180

const wrapAngle = (a: number): number =>
  ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/**
 * 3D 滚动歌词：透明的独立画布叠在可视化之上。字形是 3D 挤出体，当前行前凸、其余行缩小后退。
 * 位置决定歌词落在哪里，姿态决定它怎样朝向观众（居中不转，偏右俯视等）。
 */
export class LyricsRenderer {
  private readonly hdr: HdrPresenter
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200)
  private readonly root = new THREE.Group()
  private readonly cache = new Map<string, GlyphShapes>()
  private readonly cA = new THREE.Color()
  private readonly cI = new THREE.Color()
  private readonly targetA = new THREE.Color()
  private readonly targetI = new THREE.Color()
  private lines: Line[] = []
  private pos = -1
  private ready = false
  private style: LyricsStyle | null = null
  private readonly cur = { x: 0, y: 0, z: 0, ox: 0, oy: 0, oz: 0 }
  private width = 1
  private height = 1
  private halfW = 1
  private halfH = 1
  private maxWidth = 1
  private raf = 0
  private last = performance.now()
  private loadToken = 0
  private disposed = false
  private exporting = false
  async prepareForExport(): Promise<void> {
    await this.prepare()
  }
  renderOffline(time: number, dt: number, width: number, height: number): HTMLCanvasElement {
    this.exporting = true
    if (this.width !== width || this.height !== height) {
      this.width = width
      this.height = height
      this.renderer.setPixelRatio(1)
      this.renderer.setSize(width, height, false)
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
      this.halfH = Math.tan((FOV * DEG) / 2) * DIST
      this.halfW = this.halfH * this.camera.aspect
    }
    if (this.style) this.update(dt, time, this.style)
    this.hdr.configure(this.renderer, false, true)
    this.renderer.render(this.scene, this.camera)
    return this.canvas
  }
  endOffline(): void {
    this.exporting = false
    this.resize()
  }
  private interactive = false
  private dragging = false
  private dragPointer: number | null = null
  private dragStart = { x: 0, y: 0 }
  private dragOrigin = { x: 0, y: 0 }
  private dragNdc = { x: 0, y: 0 }
  private dragMoved = false
  private dragScale = 1
  private preview = false
  private readonly raycaster = new THREE.Raycaster()

  setPreview(preview: boolean): void {
    this.preview = preview
  }

  private readonly canvas: HTMLCanvasElement
  private readonly resizeObserver: ResizeObserver
  get presentedFrame(): HTMLCanvasElement {
    return this.canvas
  }
  mirrorHDR(presenter: HdrPresenter): boolean {
    return presenter.mirror(this.hdr, this.canvas)
  }

  constructor(
    private readonly host: HTMLElement,
    private readonly onCommit: (offset: { x: number; y: number }) => void
  ) {
    // 每次挂载都用新画布：被 forceContextLoss 的画布不能再拿到可用的 WebGL 上下文
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'absolute inset-0 size-full'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.touchAction = 'none'
    this.canvas.dataset.lyricsCanvas = ''
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    })
    host.appendChild(this.canvas)
    this.hdr = new HdrPresenter(host, true)
    this.canvas.addEventListener('webglcontextrestored', () => this.hdr.invalidate())
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(Math.min(surfacePixelRatio(), 2))
    this.root.rotation.order = 'ZXY'
    this.scene.add(this.root)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7))
    const front = new THREE.DirectionalLight(0xffffff, 0.85)
    front.position.set(0, 3, 5)
    this.scene.add(front)
    const key = new THREE.PointLight(0xffffff, 0.8)
    key.position.set(3, 4, 2)
    this.scene.add(key)
    const rim = new THREE.PointLight(0x8fa2ff, 0.5)
    rim.position.set(-4, -2, -1)
    this.scene.add(rim)

    window.addEventListener('resize', this.resize)
    this.resizeObserver = new ResizeObserver(this.resize)
    this.resizeObserver.observe(host)
    this.canvas.addEventListener('pointerdown', this.onDown)
    this.canvas.addEventListener('pointermove', this.onMove)
    // Some Android WebViews start compositor scrolling over transparent WebGL
    // layers despite touch-action. Block it only after a real lyric hit starts
    // a drag; pointercancel/capture loss still release the gesture normally.
    this.canvas.addEventListener('touchstart', this.onTouchDrag, { passive: false })
    this.canvas.addEventListener('touchmove', this.onTouchDrag, { passive: false })
    window.addEventListener('pointerup', this.onUp)
    window.addEventListener('pointercancel', this.onUp)
    window.addEventListener('blur', this.endDrag)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.canvas.addEventListener('lostpointercapture', this.onUp)
    this.resize()
    this.raf = requestAnimationFrame(this.frame)
    if (window.jap.surface === 'export') return
  }

  setInteractive(on: boolean): void {
    if (!on) this.endDrag()
    this.interactive = on
    this.canvas.style.pointerEvents = on ? 'auto' : 'none'
  }

  setStyle(style: LyricsStyle): void {
    if (!this.style) {
      this.cA.set(style.active)
      this.cI.set(style.inactive)
    }
    const fontChanged = this.style?.font !== style.font
    this.style = style
    this.canvas.hidden = !style.visible
    if (fontChanged) {
      this.freeLines(this.lines)
      void this.prepare()
    }
  }

  setText(text: string | null): void {
    this.freeLines(this.lines)
    this.lines = text ? parseLRC(text).map((l) => ({ ...l, o: null })) : []
    this.pos = -1
    void this.prepare()
  }

  dispose(): void {
    this.hdr.dispose()
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('pointercancel', this.onUp)
    window.removeEventListener('blur', this.endDrag)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.canvas.removeEventListener('lostpointercapture', this.onUp)
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('touchstart', this.onTouchDrag)
    this.canvas.removeEventListener('touchmove', this.onTouchDrag)
    this.freeLines(this.lines)
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }

  private readonly resize = (): void => {
    if (this.exporting) return
    this.renderer.setPixelRatio(surfacePixelRatio() * useSettings.getState().renderScale)
    this.width = Math.max(1, this.host.clientWidth)
    this.height = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(this.width, this.height, false)
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    this.halfH = Math.tan((FOV * DEG) / 2) * DIST
    this.halfW = this.halfH * this.camera.aspect
    const s = this.style
    if (s && s.visible) {
      this.renderer.render(this.scene, this.camera)
    }
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.interactive || e.button !== 0 || this.dragPointer !== null) return
    const rect = this.canvas.getBoundingClientRect()
    const point = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((e.clientY - rect.top) / rect.height) * 2
    )
    this.scene.updateMatrixWorld(true)
    this.raycaster.setFromCamera(point, this.camera)
    let hit: { point: THREE.Vector3 } | undefined = this.raycaster
      .intersectObject(this.root, true)
      .find(({ object }) => {
        if (!(object instanceof THREE.Mesh) || !object.visible || !object.parent?.visible)
          return false
        return (object.material as THREE.Material).opacity > 0.02
      })
    // Thin calligraphy strokes and device-pixel rounding need a small hit area.
    // Use the visible line bounds as a fallback, never the full-screen canvas.
    if (!hit) {
      for (const line of this.lines) {
        const built = line.o
        if (!built?.grp.visible || built.mat.opacity < 0.02) continue
        const box = new THREE.Box3().setFromObject(built.grp)
        let left = Infinity,
          top = Infinity,
          right = -Infinity,
          bottom = -Infinity
        for (const x of [box.min.x, box.max.x])
          for (const y of [box.min.y, box.max.y])
            for (const z of [box.min.z, box.max.z]) {
              const p = new THREE.Vector3(x, y, z).project(this.camera)
              const sx = rect.left + ((p.x + 1) * rect.width) / 2,
                sy = rect.top + ((1 - p.y) * rect.height) / 2
              left = Math.min(left, sx)
              right = Math.max(right, sx)
              top = Math.min(top, sy)
              bottom = Math.max(bottom, sy)
            }
        if (
          e.clientX >= left - 5 &&
          e.clientX <= right + 5 &&
          e.clientY >= top - 5 &&
          e.clientY <= bottom + 5
        ) {
          hit = { point: new THREE.Vector3().setFromMatrixPosition(built.grp.matrixWorld) }
          break
        }
      }
    }
    if (!hit) return
    e.preventDefault()
    this.dragging = true
    this.dragPointer = e.pointerId
    this.dragStart = { x: e.clientX, y: e.clientY }
    this.dragOrigin = { x: this.cur.ox / this.halfW, y: this.cur.oy / this.halfH }
    this.dragScale = Math.max(0.1, -hit.point.z / DIST)
    this.dragNdc = { ...this.dragOrigin }
    this.dragMoved = false
    this.canvas.setPointerCapture(e.pointerId)
    this.canvas.style.cursor = 'grabbing'
  }

  private readonly onTouchDrag = (e: TouchEvent): void => {
    if (this.dragging && e.cancelable) e.preventDefault()
  }

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.dragPointer) return
    // A mouse release outside the window can arrive without pointerup (Alt-Tab,
    // OS drag, capture loss). Never turn an adjustment into hover-following.
    if (e.pointerType !== 'touch' && (e.buttons & 1) === 0) {
      this.endDrag()
      return
    }
    this.trackPointer(e)
  }

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.dragPointer) this.endDrag()
  }
  private readonly onVisibility = (): void => {
    if (document.hidden) this.endDrag()
  }
  private readonly endDrag = (): void => {
    if (!this.dragging) return
    const pointer = this.dragPointer
    this.dragging = false
    this.dragPointer = null
    this.canvas.style.cursor = ''
    if (pointer !== null && this.canvas.hasPointerCapture(pointer))
      this.canvas.releasePointerCapture(pointer)
    if (this.dragMoved) this.onCommit({ ...this.dragNdc })
  }

  private trackPointer(e: PointerEvent): void {
    const dx = e.clientX - this.dragStart.x,
      dy = e.clientY - this.dragStart.y
    if (!this.dragMoved && Math.hypot(dx, dy) < 3) return
    this.dragMoved = true
    this.dragNdc = {
      x: clamp(this.dragOrigin.x + (dx / this.width) * 2 * this.dragScale, -0.95, 0.95),
      y: clamp(this.dragOrigin.y - (dy / this.height) * 2 * this.dragScale, -0.95, 0.95),
    }
  }

  /** 按字体加载与当前文本的字符，确保字形提取时字体已经就绪。 */
  private async prepare(): Promise<void> {
    const token = ++this.loadToken
    this.ready = false
    if (!this.style) return
    const { family, weight } = fontOf(this.style.font)
    const sample = this.lines.map((l) => l.text + l.sub).join('') + 'Aa'
    try {
      await ensureFont(this.style.font)
      await document.fonts.load(`${weight} 64px "${family}"`, sample)
    } catch {
      // 字体加载失败时仍用回退字体渲染
    }
    if (token !== this.loadToken || this.disposed) return
    this.ready = true
  }

  private geo(text: string): { g: THREE.ExtrudeGeometry; w: number } {
    const { family, weight } = fontOf(this.style?.font ?? LYRICS_FONTS[0].id)
    const key = `${family}|${weight}|${text}`
    let glyph = this.cache.get(key)
    if (!glyph) {
      glyph = glyphShapes(text, family, weight)
      this.cache.set(key, glyph)
    }
    const g = new THREE.ExtrudeGeometry(glyph.shapes, {
      depth: DEPTH,
      bevelEnabled: true,
      bevelThickness: BEVEL,
      bevelSize: BEVEL * 0.8,
      bevelSegments: 3,
      curveSegments: 2,
    })
    g.translate(0, 0, -DEPTH / 2)
    return { g, w: glyph.w }
  }

  private build(l: Line): void {
    const grp = new THREE.Group()
    const mat = new THREE.MeshStandardMaterial({
      transparent: true,
      metalness: METAL,
      roughness: ROUGH,
    })
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.55,
    })
    const subMat = mat.clone()
    const cut = { value: 0 },
      karaoke = { value: 0 },
      words: Built['words'] = []
    if (l.words?.length) {
      const { family, weight } = fontOf(this.style?.font ?? LYRICS_FONTS[0].id)
      const c = document.createElement('canvas').getContext('2d')!
      c.font = `${weight} 256px "${family}","Noto Sans SC",sans-serif`
      const center = Math.ceil(c.measureText(l.text).width) / 512
      for (const word of l.words)
        words.push({
          t: word.t,
          end: word.end,
          x0: c.measureText(l.text.slice(0, word.from)).width / 256 - center,
          x1: c.measureText(l.text.slice(0, word.to)).width / 256 - center,
        })
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uLyricCut = cut
        shader.uniforms.uLyricKaraoke = karaoke
        shader.vertexShader =
          'varying float vLyricX;\n' +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\nvLyricX=position.x;'
          )
        shader.fragmentShader =
          'varying float vLyricX;uniform float uLyricCut;uniform float uLyricKaraoke;\n' +
          shader.fragmentShader
            .replace(
              '#include <color_fragment>',
              '#include <color_fragment>\nfloat lyricFill=1.-smoothstep(uLyricCut-.006,uLyricCut+.006,vLyricX);diffuseColor.rgb=mix(diffuseColor.rgb,mix(vec3(.22),diffuseColor.rgb,lyricFill),uLyricKaraoke);'
            )
            .replace(
              '#include <emissivemap_fragment>',
              '#include <emissivemap_fragment>\ntotalEmissiveRadiance*=mix(1.,.15+.85*lyricFill,uLyricKaraoke);'
            )
      }
      mat.customProgramCacheKey = () => 'lyrics-word-v1'
    }
    let w = 0
    const add = (text: string, scale: number, y: number): void => {
      if (!text) return
      const { g, w: tw } = this.geo(text)
      // 3D 柔和背影，确保任何背景下字型轮廓分明
      const shadowMesh = new THREE.Mesh(g, shadowMat)
      shadowMesh.position.set(0.012 * scale, y - 0.012 * scale, -DEPTH * 0.6)
      shadowMesh.scale.setScalar(scale)
      grp.add(shadowMesh)

      // 主体 3D 挤出网格
      const mesh = new THREE.Mesh(g, scale === 1 ? mat : subMat)
      mesh.position.y = y
      mesh.scale.setScalar(scale)
      grp.add(mesh)
      w = Math.max(w, tw * scale)
    }
    add(l.text, 1, l.sub ? 0.3 : 0)
    add(l.sub, SUB_SCALE, -0.55)
    this.root.add(grp)
    l.o = { grp, mat, shadowMat, subMat, w: w || 1, cut, karaoke, words }
  }

  private free(l: Line): void {
    if (!l.o) return
    l.o.grp.traverse((c) => {
      if (c instanceof THREE.Mesh) c.geometry.dispose()
    })
    l.o.mat.dispose()
    l.o.shadowMat.dispose()
    l.o.subMat.dispose()
    this.root.remove(l.o.grp)
    l.o = null
  }

  private freeLines(lines: Line[]): void {
    for (const l of lines) this.free(l)
  }

  /** 位置：左右两侧与底部用偏移，自定义用拖动得到的归一化坐标。 */
  private targetOffset(s: LyricsStyle): { x: number; y: number; z: number } {
    const pxToWorldY = ((s.offset.y || 0) / (this.height || 1)) * 2 * this.halfH
    const pxToWorldX = ((s.offset.x || 0) / (this.width || 1)) * 2 * this.halfW
    const pxToWorldZ = (s.offset.z || 0) * 0.01

    switch (s.position) {
      case 'left':
        return { x: -this.halfW * POSITION_OFFSET.side + pxToWorldX, y: pxToWorldY, z: pxToWorldZ }
      case 'right':
        return { x: this.halfW * POSITION_OFFSET.side + pxToWorldX, y: pxToWorldY, z: pxToWorldZ }
      case 'bottom':
        return {
          x: pxToWorldX,
          y: -this.halfH * POSITION_OFFSET.bottom + pxToWorldY,
          z: pxToWorldZ,
        }
      case 'custom':
        return { x: s.offset.x * this.halfW, y: s.offset.y * this.halfH, z: pxToWorldZ }
      default:
        return { x: pxToWorldX, y: pxToWorldY, z: pxToWorldZ }
    }
  }

  private update(dt: number, timeSec: number, s: LyricsStyle): void {
    const sideLayout = s.position === 'left' || s.position === 'right'
    this.maxWidth = 2 * this.halfW * (sideLayout ? SIDE_BUDGET : WIDE_BUDGET)

    const k = 1 - Math.exp(-dt * FOLLOW)
    const target = this.targetOffset(s)
    if (this.dragging) {
      this.cur.ox = this.dragNdc.x * this.halfW
      this.cur.oy = this.dragNdc.y * this.halfH
      this.cur.oz = target.z
    } else {
      this.cur.ox += (target.x - this.cur.ox) * k
      this.cur.oy += (target.y - this.cur.oy) * k
      this.cur.oz += (target.z - this.cur.oz) * k
    }

    const pose: PoseTarget = resolvePose(s.pose, s.position, s.rotation, s.spin, timeSec)
    this.cur.x += wrapAngle(pose.x - this.cur.x) * k
    this.cur.y += wrapAngle(pose.y - this.cur.y) * k
    this.cur.z += wrapAngle(pose.z - this.cur.z) * k

    this.root.position.set(this.cur.ox, this.cur.oy, -DIST + this.cur.oz)
    this.root.rotation.set(this.cur.x, this.cur.y, this.cur.z)

    if (!this.ready || this.lines.length === 0) return
    const L = this.lines
    let idx = -1
    for (let i = 0; i < L.length && L[i]!.t <= timeSec; i++) idx = i
    this.pos += (idx - this.pos) * (1 - Math.exp(-SPEED * dt))
    this.cA.lerp(this.targetA.set(s.active), 1 - Math.exp(-dt * 4))
    this.cI.lerp(this.targetI.set(s.inactive), 1 - Math.exp(-dt * 4))

    const curve = CURVE
    const reach = RANGE + 1
    for (let i = 0; i < L.length; i++) {
      const l = L[i]!
      const d = i - this.pos
      const ad = Math.abs(d)
      if (ad > reach) {
        if (ad > reach + 2) this.free(l)
        else if (l.o) l.o.grp.visible = false
        continue
      }
      if (!l.o && (l.text || l.sub)) this.build(l)
      const o = l.o
      if (!o) continue
      const act = Math.max(0, 1 - ad)
      const op = Math.pow(1 - ad / reach, 1.5)
      const y0 = (-d * SPACING * s.size) / 100
      const a = y0 * curve
      const curved = curve > 1e-3
      const scale =
        ((SIZE * s.size) / 100) *
        (INACTIVE_SCALE + (1 - INACTIVE_SCALE) * act) *
        Math.min(1, (this.maxWidth * 0.92) / ((o.w * SIZE * s.size) / 100))
      o.grp.visible = true
      o.grp.position.set(
        0,
        curved ? Math.sin(a) / curve : y0,
        (curved ? (Math.cos(a) - 1) / curve : 0) + POP * act
      )
      o.grp.rotation.x = -a
      o.grp.scale.setScalar(scale)
      const m = o.mat
      o.karaoke.value = i === idx && o.words.length ? 1 : 0
      if (o.karaoke.value) {
        let x = o.words[0]!.x0
        for (const word of o.words) {
          const p = wordProgress({ ...word, text: '', from: 0, to: 0 }, timeSec)
          x = word.x0 + (word.x1 - word.x0) * p
          if (timeSec < word.end) break
        }
        o.cut.value = x
      }
      m.color.lerpColors(this.cI, this.cA, act)
      // 基础自发光让远离中心的行也保持可读，不会在暗色舞台上糊成灰色
      m.emissive.lerpColors(this.cI, this.cA, act).multiplyScalar(EMISSIVE_BASE + GLOW * act)
      m.opacity = op
      m.metalness = METAL
      m.roughness = ROUGH
      o.subMat.color.copy(m.color)
      o.subMat.emissive.copy(m.emissive)
      o.subMat.opacity = m.opacity
      o.shadowMat.opacity = s.shadow ? op * 0.55 : 0
    }
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.frame)
    if (
      this.exporting ||
      (document.hidden && document.documentElement.dataset['windowMode'] !== 'wallpaper') ||
      document.documentElement.dataset['windowMode'] === 'mini' ||
      document.documentElement.dataset['renderSuspended'] === '1'
    )
      return
    const fps = useSettings.getState().renderFps
    if (fps > 0 && now - this.last < 1000 / fps - 0.5) return
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    const s = this.style
    if (!s || !s.visible) return
    this.update(dt, this.preview ? 12 : livePositionMs() / 1000, s)
    this.hdr.configure(this.renderer)
    this.renderer.render(this.scene, this.camera)
    this.hdr.present(this.canvas)
  }
}
