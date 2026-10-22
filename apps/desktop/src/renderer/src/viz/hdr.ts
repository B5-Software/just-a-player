/// <reference types="@webgpu/types" />
import * as THREE from 'three'
import { create } from 'zustand'
import { useSettings } from '../settings/store'
import { NativeHdrPresenter, type NativeShaderFrame } from './native-hdr'
interface FloatGL extends WebGL2RenderingContext {
  drawingBufferStorage?: (format: number, width: number, height: number) => void
}
export const useHdr = create<{ supported: boolean; active: boolean; reason: string }>(() => ({
  supported: false,
  active: false,
  reason: '正在检查显示器与渲染器…',
}))
let devicePromise: Promise<GPUDevice> | null = null,
  failure = ''
const presenters = new Set<HdrPresenter>()
const shader = `
@vertex fn vertex(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
  var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(@builtin(position) p:vec4f) -> @location(0) vec4f {
  return textureLoad(image,vec2i(p.xy),0);
}`
function device(): Promise<GPUDevice> {
  return (devicePromise ??= (async () => {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('没有可用的 WebGPU 设备')
    const gpu = await adapter.requestDevice()
    gpu.addEventListener('uncapturederror', (event) => {
      failure = event.error.message
      for (const p of presenters) p.hide()
    })
    void gpu.lost.then((info) => {
      failure = info.message || 'HDR 输出设备已断开'
      for (const p of presenters) p.hide()
    })
    return gpu
  })())
}
/**
 * Render each scene once with Three/WebGL. A GPU image copy preserves the RGBA16F
 * source (including values above 1) and presents it through an extended-range
 * WebGPU canvas. No full-frame CPU readback or second scene renderer is used.
 */
export class HdrPresenter {
  private readonly native: NativeHdrPresenter | null
  readonly canvas = document.createElement('canvas')
  private gpu: GPUDevice | null = null
  private context: GPUCanvasContext | null = null
  private pipeline: GPURenderPipeline | null = null
  private image: GPUTexture | null = null
  private binding: GPUBindGroup | null = null
  private pending = false
  private disposed = false
  private formatKey = ''
  private floatStorage = false
  active = false
  constructor(
    host: HTMLElement,
    private readonly transparent = false
  ) {
    this.native = window.jap.nativeHdr && !transparent ? new NativeHdrPresenter() : null
    this.canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;visibility:hidden;z-index:1'
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.dataset.hdrPresenter = this.transparent ? 'lyrics' : 'scene'
    host.appendChild(this.canvas)
    presenters.add(this)
  }
  hide(): void {
    this.active = false
    this.canvas.style.visibility = 'hidden'
  }
  invalidate(): void {
    this.formatKey = ''
    this.floatStorage = false
  }
  private async initialize(): Promise<void> {
    if (this.pending || this.gpu || this.disposed) return
    this.pending = true
    try {
      const gpu = await device()
      if (this.disposed) return
      const context = this.canvas.getContext('webgpu')
      if (!context) throw new Error('HDR 画布不可用')
      context.configure({
        device: gpu,
        format: 'rgba16float',
        colorSpace: 'srgb',
        toneMapping: { mode: 'extended' },
        alphaMode: this.transparent ? 'premultiplied' : 'opaque',
      })
      if (context.getConfiguration()?.toneMapping?.mode !== 'extended')
        throw new Error('运行时不支持扩展亮度输出')
      const module = gpu.createShaderModule({ code: shader })
      const pipeline = await gpu.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
      })
      if (this.disposed) {
        context.unconfigure()
        return
      }
      this.gpu = gpu
      this.context = context
      this.pipeline = pipeline
    } catch (e) {
      failure = String(e)
      this.hide()
    } finally {
      this.pending = false
    }
  }
  configure(
    renderer: THREE.WebGLRenderer,
    report = false,
    offline = false,
    shader?: NativeShaderFrame
  ): boolean {
    if (window.jap.nativeHdr) {
      this.hide()
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      if (this.native) {
        const status = this.native.configure(offline, shader)
        if (report) {
          const old = useHdr.getState()
          if (
            old.supported !== status.supported ||
            old.active !== status.active ||
            old.reason !== status.reason
          )
            useHdr.setState(status)
        }
      }
      return false
    }
    const gl = renderer.getContext() as FloatGL
    const display = matchMedia('(dynamic-range: high)').matches
    const capable =
      Boolean(navigator.gpu) &&
      typeof gl.drawingBufferStorage === 'function' &&
      Boolean(gl.getExtension('EXT_color_buffer_float'))
    const supported = display && capable && !failure
    const requested = supported && useSettings.getState().hdrEnabled && !offline
    if (requested && !this.gpu) void this.initialize()
    this.active = requested && Boolean(this.gpu)
    const key = `${this.active}:${gl.drawingBufferWidth}:${gl.drawingBufferHeight}`
    if (key !== this.formatKey) {
      if (capable) {
        if (this.floatStorage !== this.active) {
          // Chromium can retain an 8-bit canvas snapshot provider after changing
          // only GL storage. Invalidate the bitmap before the first HDR frame.
          renderer.domElement.width = renderer.domElement.width
          this.floatStorage = this.active
        }
        gl.drawingBufferStorage!(
          this.active ? gl.RGBA16F : gl.RGBA8,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight
        )
        if (gl.getError() !== gl.NO_ERROR) {
          failure = '浮点绘制缓冲不可用'
          this.hide()
          gl.drawingBufferStorage!(gl.RGBA8, gl.drawingBufferWidth, gl.drawingBufferHeight)
        }
      }
      renderer.toneMapping = this.active ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping
      this.formatKey = key
    }
    if (!this.active) this.hide()
    if (report) {
      const reason = failure
        ? `HDR 不可用：${failure}`
        : !display
          ? '当前屏幕未启用或不支持 HDR；请检查系统显示设置。'
          : !capable
            ? '当前运行时或 GPU 不支持浮点 HDR 输出。'
            : this.active
              ? 'HDR 已启用 · 16 位浮点扩展亮度 · 主窗口与桌面壁纸共用设置。'
              : requested
                ? '正在准备 HDR 输出…'
                : '支持 HDR。开启后保留动效高光与泛光的扩展亮度。'
      const old = useHdr.getState()
      if (old.supported !== supported || old.active !== this.active || old.reason !== reason)
        useHdr.setState({ supported, active: this.active, reason })
    }
    return this.active
  }
  present(source: HTMLCanvasElement): boolean {
    if (!this.active || !this.gpu || !this.context || !this.pipeline || failure) {
      this.hide()
      return false
    }
    try {
      const gpu = this.gpu,
        w = source.width,
        h = source.height
      if (!this.image || this.canvas.width !== w || this.canvas.height !== h) {
        this.image?.destroy()
        this.canvas.width = w
        this.canvas.height = h
        this.image = gpu.createTexture({
          size: [w, h],
          format: 'rgba16float',
          usage:
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_SRC,
        })
        this.binding = gpu.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: this.image.createView() }],
        })
      }
      gpu.queue.copyExternalImageToTexture(
        { source },
        { texture: this.image, colorSpace: 'srgb', premultipliedAlpha: this.transparent },
        [w, h]
      )
      const encoder = gpu.createCommandEncoder(),
        pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.context.getCurrentTexture().createView(),
              clearValue: [0, 0, 0, this.transparent ? 0 : 1],
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        })
      pass.setPipeline(this.pipeline)
      pass.setBindGroup(0, this.binding!)
      pass.draw(3)
      pass.end()
      gpu.queue.submit([encoder.finish()])
      this.canvas.style.visibility = 'visible'
      return true
    } catch (e) {
      failure = String(e)
      this.hide()
      return false
    }
  }
  presentNative(
    shader: NativeShaderFrame | undefined,
    width: number,
    height: number,
    cover: HTMLCanvasElement | null
  ): boolean {
    return this.native?.present(shader, width, height, cover) ?? false
  }
  /** Mirror the same completed HDR frame; never resize/re-render its GL source. */
  mirror(source: HdrPresenter, canvas: HTMLCanvasElement): boolean {
    if (!source.active) {
      this.hide()
      return false
    }
    if (!this.gpu) void this.initialize()
    this.active = Boolean(this.gpu)
    return this.present(canvas)
  }
  dispose(): void {
    this.native?.dispose()
    this.disposed = true
    presenters.delete(this)
    this.image?.destroy()
    this.context?.unconfigure()
    this.canvas.remove()
  }
}
