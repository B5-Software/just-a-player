import { surfacePixelRatio } from '../lib/pixel-ratio'
import { useSettings } from '../settings/store'
export interface NativeShaderFrame {
  fragment: string
  uniforms: Record<string, number | number[]>
  textures?: NativeShaderTexture[]
}
export interface NativeShaderTexture {
  name: string
  width: number
  height: number
  version: number
  data: Uint8Array
}
export function serializeNativeTextures(
  textures: NativeShaderTexture[] = []
): { name: string; width: number; height: number; data: string }[] {
  return textures.map((t) => {
    let binary = ''
    for (let i = 0; i < t.data.length; i += 8192)
      binary += String.fromCharCode(...t.data.subarray(i, i + 8192))
    return { name: t.name, width: t.width, height: t.height, data: btoa(binary) }
  })
}
/** Only parameters cross the bridge. The selected shader is drawn once by EGL. */
export class NativeHdrPresenter {
  private readonly api = window.jap.nativeHdr!
  private enabled = false
  private pending = false
  private disposed = false
  private failure = ''
  private shader = ''
  private signature = ''
  private textureVersions = new Map<string, number>()
  private backdrop: HTMLCanvasElement | null | undefined
  active = false
  private readonly off = this.api.onState((state) => {
    this.active = state.active
    if (!state.active) {
      this.enabled = false
      this.shader = ''
      this.backdrop = undefined
      this.textureVersions.clear()
      if (!state.reason.includes('已关闭')) {
        this.failure = state.reason
        void this.api.configure(false).catch(() => {})
      }
    }
    document.documentElement.dataset.nativeHdr = state.active ? '1' : ''
  })
  configure(
    offline: boolean,
    shader?: NativeShaderFrame
  ): { supported: boolean; active: boolean; reason: string } {
    const settings = useSettings.getState()
    if (!settings.hdrEnabled) this.failure = ''
    const display = this.api.info.supported
    const visible =
      document.documentElement.dataset.windowMode !== 'mini' &&
      document.documentElement.dataset.renderSuspended !== '1'
    const wanted =
      display && !!shader && settings.hdrEnabled && !offline && visible && !this.failure
    if (wanted !== this.enabled) {
      this.enabled = wanted
      this.shader = ''
      this.backdrop = undefined
      void this.api.configure(wanted).catch((e) => {
        this.failure = String(e)
        this.active = false
        this.enabled = false
        document.documentElement.dataset.nativeHdr = ''
      })
    }
    return {
      supported: display && !!shader && !this.failure,
      active: this.active,
      reason: this.failure
        ? `HDR 输出失败：${this.failure}`
        : !display
          ? `Android 当前显示器未报告 HDR（WebView ${this.api.info.webView}）。`
          : !shader
            ? '当前场景未提供原生 HDR 着色器。'
            : this.active
              ? 'Android 原生 GPU HDR · 分辨率与帧率跟随画质设置 · 无逐帧像素回读。'
              : wanted
                ? '正在建立原生 GPU HDR 输出…'
                : '显示器支持 HDR，开启后直接由原生 GPU 绘制。',
    }
  }
  present(
    frame: NativeShaderFrame | undefined,
    width: number,
    height: number,
    cover: HTMLCanvasElement | null
  ): boolean {
    if (!frame || !this.enabled || this.failure || this.disposed) return false
    if (!this.pending) {
      this.pending = true
      const fragment = frame.fragment === this.shader ? undefined : frame.fragment
      const backdrop =
        cover === this.backdrop ? undefined : (cover?.toDataURL('image/jpeg', 0.9) ?? null)
      const changedTextures = (frame.textures ?? []).filter(
        (t) => fragment !== undefined || this.textureVersions.get(t.name) !== t.version
      )
      const textureRevisions = changedTextures.map((t) => [t.name, t.version] as const)
      const signature = JSON.stringify(
        [frame.uniforms, (frame.textures ?? []).map((t) => [t.name, t.version])],
        (_key, value) => (typeof value === 'number' ? Math.round(value * 10000) / 10000 : value)
      )
      if (
        this.active &&
        fragment === undefined &&
        backdrop === undefined &&
        signature === this.signature
      ) {
        this.pending = false
        return true
      }
      const scale = surfacePixelRatio() * useSettings.getState().renderScale
      void this.api
        .scene({
          fragment,
          uniforms: frame.uniforms,
          width: Math.max(2, Math.round(width * scale)),
          height: Math.max(2, Math.round(height * scale)),
          backdrop,
          textures: serializeNativeTextures(changedTextures),
        })
        .then((accepted) => {
          if (accepted) {
            this.shader = frame.fragment
            this.backdrop = cover
            this.signature = signature
            for (const [name, version] of textureRevisions) this.textureVersions.set(name, version)
          }
        })
        .catch((e) => {
          this.failure = String(e)
          this.active = false
          this.enabled = false
          document.documentElement.dataset.nativeHdr = ''
          void this.api.configure(false).catch(() => {})
        })
        .finally(() => {
          this.pending = false
        })
    }
    return this.active
  }
  dispose(): void {
    this.disposed = true
    this.off()
    document.documentElement.dataset.nativeHdr = ''
    void this.api.configure(false).catch(() => {})
  }
}
