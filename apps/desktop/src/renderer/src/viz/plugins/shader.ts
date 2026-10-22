import * as THREE from 'three'
import type { VisualPlugin } from '@shared/visual-plugin'
import type { SceneDef, VizScene } from '../scenes/common'
import type { AudioState } from '../audio'
import type { NativeShaderTexture } from '../native-hdr'

export interface ShaderDriver {
  values: Record<string, number | number[]>
  textures?: { texture: THREE.DataTexture; frame: NativeShaderTexture }[]
  instrument?: boolean
  update(audio: AudioState): void
  resize?(width: number, height: number): void
  dispose?(): void
}

export const shaderUniforms = `
uniform vec2 uRes; uniform float uTime; uniform vec4 uAudio;
uniform vec3 uAccent; uniform vec3 uSecond; uniform vec2 uPointer; uniform vec3 uView;
uniform sampler2D uBackdrop; uniform sampler2D uBackdropPrevious; uniform float uBackdropMix; uniform float uBackdropFlip;
uniform float uBackdropOn; uniform float uBackdropGain;
`
export const shaderLibrary = `
mat2 rotate(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float grain(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec3 background(vec2 uv){
  vec2 p=uv-.5;
  float halo=exp(-dot(p-vec2(-.22,.10),p-vec2(-.22,.10))*3.4);
  vec3 base=vec3(.003,.005,.009)+mix(uAccent,uSecond,uv.y)*(.008+.022*halo);
  vec2 cuv=vec2(uv.x,mix(uv.y,1.-uv.y,uBackdropFlip));
  vec3 cover=mix(texture(uBackdropPrevious,cuv).rgb,texture(uBackdrop,cuv).rgb,uBackdropMix);
  return mix(base,cover*uBackdropGain,uBackdropOn*.88);
}
vec3 studioLight(vec3 n,vec3 v,vec3 albedo,float gloss){
  vec3 l=normalize(vec3(-.5,.85,1.2));
  float diffuse=max(dot(n,l),0.);
  float rim=pow(1.-max(dot(n,v),0.),3.);
  float soft=pow(max(dot(reflect(-l,n),v),0.),mix(12.,80.,gloss));
  vec3 fill=mix(vec3(.32,.36,.43),uSecond,.35);
  return albedo*(.18+diffuse*.85)+fill*.20+soft*vec3(1.6,1.42,1.25)+rim*mix(uSecond,vec3(1.),.3)*.42;
}
vec2 screenPoint(vec2 uv){return (uv-.5-uView.xy)*vec2(uRes.x/uRes.y,1.)/max(uView.z,.2);}
`
export function shaderBody(plugin: VisualPlugin): string {
  return shaderUniforms + shaderLibrary + plugin.fragment
}
export function checkShader(plugin: VisualPlugin): void {
  const canvas = document.createElement('canvas'),
    gl = canvas.getContext('webgl2')
  if (!gl) throw Error('当前设备不能编译 WebGL 2 效果插件')
  const shader = gl.createShader(gl.FRAGMENT_SHADER)!
  try {
    gl.shaderSource(
      shader,
      `#version 300 es\nprecision highp float;in vec2 vUv;out vec4 color;${shaderBody(plugin)}\nvoid main(){color=vec4(visualize(vUv),1.);}`
    )
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw Error(gl.getShaderInfoLog(shader) || '插件着色器编译失败')
  } finally {
    gl.deleteShader(shader)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
const empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
empty.needsUpdate = true
export function shaderScene(
  plugin: VisualPlugin,
  external = false,
  createDriver?: () => ShaderDriver
): SceneDef {
  return {
    id: (external ? 'user-' : '') + plugin.id,
    name: plugin.name,
    hint: plugin.description,
    create(): VizScene {
      const scene = new THREE.Scene(),
        camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
      const values = {
        uRes: [1, 1],
        uTime: 0,
        uAudio: [0, 0, 0, 0],
        uAccent: [0.4, 0.25, 0.7],
        uSecond: [0.4, 0.6, 0.8],
        uPointer: [0, 0],
        uView: [0, 0, 1],
        uBackdropOn: 0,
        uBackdropGain: 0.25,
        uBackdropMix: 1,
        uBackdropFlip: 0,
      }
      const uniforms: Record<string, THREE.IUniform> = {}
      for (const [key, value] of Object.entries(values)) uniforms[key] = { value }
      const driver = createDriver?.()
      for (const [key, value] of Object.entries(driver?.values ?? {})) uniforms[key] = { value }
      for (const t of driver?.textures ?? []) uniforms[t.frame.name] = { value: t.texture }
      uniforms.uBackdrop = { value: empty }
      uniforms.uBackdropPrevious = { value: empty }
      const body = shaderBody(plugin)
      const material = new THREE.RawShaderMaterial({
        uniforms,
        glslVersion: THREE.GLSL3,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        vertexShader:
          'precision highp float;in vec3 position;in vec2 uv;out vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position,1.);}',
        fragmentShader: `precision highp float;in vec2 vUv;out vec4 color;${body}\nvoid main(){color=vec4(clamp(visualize(vUv),vec3(0.),vec3(8.)),1.);}`,
      })
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)
      )
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))
      const quad = new THREE.Mesh(geometry, material)
      quad.frustumCulled = false
      scene.add(quad)
      return {
        scene,
        camera,
        clean: true,
        instrument: driver?.instrument,
        bloom: { strength: 0, radius: 0, threshold: 1 },
        update(a, p, input) {
          values.uTime = a.time
          uniforms.uTime!.value = a.time
          values.uAudio = [a.bass, a.mid, a.treble, a.energy]
          uniforms.uAudio!.value = values.uAudio
          p.accent.toArray(values.uAccent)
          p.second.toArray(values.uSecond)
          values.uPointer[0] = input.pointer.x
          values.uPointer[1] = input.pointer.y
          driver?.update(a)
          for (const [key, value] of Object.entries(driver?.values ?? {}))
            uniforms[key]!.value = value
        },
        resize(w, h) {
          values.uRes[0] = w
          values.uRes[1] = h
          driver?.resize?.(w, h)
        },
        setView(x, y, z) {
          values.uView[0] = x
          values.uView[1] = -y
          values.uView[2] = z
        },
        setBackdrop(texture, gain) {
          uniforms.uBackdrop!.value = texture ?? empty
          values.uBackdropOn = texture ? 1 : 0
          values.uBackdropGain = gain
          uniforms.uBackdropOn!.value = values.uBackdropOn
          uniforms.uBackdropGain!.value = gain
        },
        nativeShader: () => ({
          fragment: body,
          uniforms: { ...values, ...driver?.values },
          textures: driver?.textures?.map((t) => t.frame),
        }),
        dispose() {
          geometry.dispose()
          material.dispose()
          driver?.dispose?.()
        },
      }
    },
  }
}
