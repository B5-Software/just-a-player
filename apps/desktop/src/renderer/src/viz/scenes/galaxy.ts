import * as THREE from 'three'
import { GLSL_BANDS } from '../glsl'
import { disposeScene, glowTexture, type SceneDef, type VizScene } from './common'

const COUNT = 90000
const BG = 0x03030a

const galaxyVertex = /* glsl */ `
${GLSL_BANDS}
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;
uniform float uBeatR;
uniform float uPx;
uniform vec3 uAccent;
uniform vec3 uSecond;
uniform vec3 uThird;
attribute vec4 aRand;      // x: 半径(0..1)  y: 旋臂起始角  z: 大小  w: 颜色抖动
attribute vec3 aScatter;
varying vec3 vColor;
varying float vAlpha;

void main(){
  float r01 = aRand.x;
  float R = 9.5;
  float spin = uTime * (0.22 + uMid * 0.35) / (0.35 + r01 * 1.5);
  float ang = aRand.y + r01 * 5.2 + spin;

  float pulse = bandAt(r01);
  float r = r01 * R * (1.0 + pulse * 0.22);
  vec3 pos = vec3(cos(ang) * r, 0.0, sin(ang) * r);
  pos += aScatter * (0.25 + r01 * 1.25);
  pos.y *= 0.3;
  pos.y += sin(r * 1.3 - uTime * 2.0) * pulse * 0.8;

  float wave = exp(-pow((r01 - uBeatR) * 7.0, 2.0)) * step(uBeatR, 1.0);
  vec3 col = mix(uThird * 1.7, uAccent, smoothstep(0.0, 0.42, r01));
  col = mix(col, uSecond, smoothstep(0.5, 1.0, r01));
  col *= 0.75 + aRand.w * 0.5;
  col += wave * 0.9;
  vColor = col;
  vAlpha = (0.55 + 0.45 * sin(uTime * (3.0 + aRand.z * 6.0) + aRand.w * 60.0) * uTreble * 1.8) * (0.7 + pulse * 0.8);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = (aRand.z * 1.2 + 0.6) * (1.0 + uBass * 0.5 + wave * 2.2);
  gl_PointSize = size * uPx * (42.0 / -mv.z);
}
`

const galaxyFragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  gl_FragColor = vec4(vColor * a * vAlpha * 0.085, a);
}
`

function create(): VizScene {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300)

  const rand = new Float32Array(COUNT * 4)
  const scatter = new Float32Array(COUNT * 3)
  const positions = new Float32Array(COUNT * 3)
  const arms = 3
  for (let i = 0; i < COUNT; i++) {
    const r01 = Math.pow(Math.random(), 1.35)
    rand[i * 4] = r01
    rand[i * 4 + 1] = (Math.floor(Math.random() * arms) / arms) * Math.PI * 2
    rand[i * 4 + 2] = Math.random()
    rand[i * 4 + 3] = Math.random()
    const s = () => (Math.random() - 0.5) * 2 * Math.pow(Math.random(), 2.2)
    scatter[i * 3] = s()
    scatter[i * 3 + 1] = s()
    scatter[i * 3 + 2] = s()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
  geometry.setAttribute('aScatter', new THREE.BufferAttribute(scatter, 3))

  const uniforms = {
    uBands: { value: new Float32Array(128) },
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uBeatR: { value: 2 },
    uPx: { value: Math.min(window.devicePixelRatio, 2) },
    uAccent: { value: new THREE.Color() },
    uSecond: { value: new THREE.Color() },
    uThird: { value: new THREE.Color() }
  }
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: galaxyVertex,
      fragmentShader: galaxyFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  )
  points.frustumCulled = false
  const galaxy = new THREE.Group()
  galaxy.add(points)
  scene.add(galaxy)

  const glow = glowTexture()
  const core = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  )
  scene.add(core)

  return {
    scene,
    camera,
    bloom: { strength: 0.6, radius: 0.7, threshold: 0.4 },
    update(a, p, input) {
      uniforms.uBands.value.set(a.bands)
      uniforms.uTime.value = a.time
      uniforms.uBass.value = a.bass
      uniforms.uMid.value = a.mid
      uniforms.uTreble.value = a.treble
      uniforms.uBeat.value = a.beat
      // 鼓点后让一圈光波从核心扩散到边缘
      uniforms.uBeatR.value = a.sinceBeat * 0.8
      uniforms.uAccent.value.copy(p.accent)
      uniforms.uSecond.value.copy(p.second)
      uniforms.uThird.value.copy(p.third)

      galaxy.rotation.y = a.time * 0.04
      core.material.color.copy(p.third)
      core.scale.setScalar(1.8 + a.bass * 2 + a.beat * 1.5)
      core.material.opacity = 0.3 + a.beat * 0.4

      camera.position.set(input.pointer.x * 3, 7.5 - input.pointer.y * 2 + Math.sin(a.time * 0.13) * 1.2, 13.5)
      camera.lookAt(0, 0, 0)
    },
    resize(w, h) {
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      uniforms.uPx.value = Math.min(window.devicePixelRatio, 2)
    },
    dispose() {
      glow.dispose()
      disposeScene(scene)
    }
  }
}

export const galaxyScene: SceneDef = { id: 'galaxy', name: '星云漩涡', hint: '九万颗星尘随频谱呼吸的旋臂星系', create }
