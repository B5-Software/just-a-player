import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

/** 色差 + 暗角 + 胶片颗粒；鼓点时色差瞬间拉开，切场景时整体淡出。 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tPrevious: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uBeat: { value: 0 },
    uFade: { value: 0 },
    uClean: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tPrevious;
    uniform float uTime;
    uniform float uBeat;
    uniform float uFade;
    uniform float uClean;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      // 切场景时轻微向内收缩，配合淡出
      vec2 uv = vUv;
      float cinematic = 1.0 - uClean;
      vec2 off = c * (0.0012 + uBeat * 0.0065) * (1.0 + r2 * 3.0) * cinematic;
      vec3 col = vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
      col *= 1.0 - smoothstep(0.32, 0.98, length(c) * 1.25) * 0.62 * cinematic;
      col += (hash(vUv * uRes + fract(uTime) * 91.7) - 0.5) * 0.022 * cinematic;
      col = mix(col, texture2D(tPrevious, vUv).rgb, uFade);
      gl_FragColor = vec4(col, 1.0);
    }
  `
}

/** 渲染 -> 泛光 -> 终处理 -> 色调映射/色彩空间输出。 */
export class PostStack {
  readonly composer: EffectComposer
  private readonly renderPass: RenderPass
  readonly bloom: UnrealBloomPass
  private readonly final: ShaderPass
  private readonly previous: THREE.WebGLRenderTarget
  private readonly output: OutputPass
  private pixelRatio = 0

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType })
    this.previous = target.clone()
    this.composer = new EffectComposer(renderer, target)
    this.renderPass = new RenderPass(scene, camera)
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 1, 0.6, 0.1)
    this.final = new ShaderPass(FinalShader)
    this.final.uniforms['tPrevious']!.value = this.previous.texture
    this.output = new OutputPass()
    // The screen-only output must not swap away the completed linear image;
    // capture() uses that image for a real scene-to-scene crossfade.
    this.output.needsSwap = false
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.bloom)
    this.composer.addPass(this.final)
    this.composer.addPass(this.output)
  }

  setSize(width: number, height: number): void {
    const pixelRatio = this.renderer.getPixelRatio()
    if (pixelRatio !== this.pixelRatio) {
      this.pixelRatio = pixelRatio
      this.composer.setPixelRatio(pixelRatio)
    }
    this.composer.setSize(width, height)
    this.previous.setSize(Math.round(width * pixelRatio), Math.round(height * pixelRatio))
    this.renderer.initRenderTarget(this.previous)
    this.final.uniforms['uRes']!.value.set(width * pixelRatio, height * pixelRatio)
  }

  capture(): void {
    this.renderer.copyTextureToTexture(this.composer.readBuffer.texture, this.previous.texture)
  }

  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    params: { time: number; beat: number; fade: number; dt: number; clean?: boolean }
  ): void {
    this.renderPass.scene = scene
    this.renderPass.camera = camera
    this.final.uniforms['uTime']!.value = params.time
    this.final.uniforms['uBeat']!.value = params.beat
    this.final.uniforms['uFade']!.value = params.fade
    this.final.uniforms['uClean']!.value = params.clean ? 1 : 0
    this.composer.render(params.dt)
  }

  dispose(): void {
    this.bloom.dispose()
    this.final.dispose()
    this.output.dispose()
    this.previous.dispose()
    this.composer.dispose()
  }
}
