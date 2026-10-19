import * as THREE from 'three'
import { disposeScene, SpectrumHistory, type SceneDef, type VizScene } from './common'

const COLS = 128
const ROWS = 96
const BG = 0x05040c

const terrainVertex = /* glsl */ `
uniform sampler2D uHistory;
uniform float uHead;
varying float vH;
varying vec2 vUv;

float rowValue(float u, int row){
  float fx = clamp(u, 0.0, 1.0) * float(${COLS - 1});
  int x0 = int(floor(fx));
  int x1 = min(x0 + 1, ${COLS - 1});
  return mix(texelFetch(uHistory, ivec2(x0, row), 0).r, texelFetch(uHistory, ivec2(x1, row), 0).r, fract(fx));
}

void main(){
  vUv = uv;
  int age = int(floor(uv.y * float(${ROWS - 1}) + 0.5));
  int row = (int(uHead) - age + ${ROWS * 4}) % ${ROWS};
  // 镜像：低频在中央，两侧是高频，整座山脉左右对称
  float v = rowValue(abs(uv.x * 2.0 - 1.0), row);
  float edge = smoothstep(0.0, 0.2, uv.x) * smoothstep(1.0, 0.8, uv.x);
  float h = pow(v, 1.5) * 12.0 * mix(0.3, 1.0, edge);
  h *= 0.3 + 0.7 * smoothstep(1.0, 0.45, uv.y);
  vH = h / 12.0;
  vec3 pos = position;
  pos.y += h;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`

const terrainFragment = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uSecond;
uniform vec3 uThird;
uniform float uBeat;
varying float vH;
varying vec2 vUv;

void main(){
  vec2 g = vec2(vUv.x * 64.0, vUv.y * float(${ROWS - 1}));
  vec2 f = abs(fract(g - 0.5) - 0.5) / fwidth(g);
  float line = 1.0 - min(min(f.x, f.y), 1.0);

  vec3 col = mix(uAccent, uSecond, smoothstep(0.0, 0.45, vH));
  col = mix(col, uThird, smoothstep(0.4, 1.0, vH));

  float far = smoothstep(0.55, 1.0, vUv.y);
  float glow = line * (0.3 + vH * 4.0 + uBeat * 0.9);
  vec3 outc = col * glow * (1.0 - far * 0.9);
  outc += col * 0.02 * (1.0 - vUv.y);
  gl_FragColor = vec4(outc, 1.0);
}
`

const sunFragment = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uThird;
uniform float uTime;
uniform float uBeat;
varying vec2 vUv;

void main(){
  float d = length(vUv - 0.5) * 2.0;
  float disc = smoothstep(1.0, 0.97, d);
  float y = vUv.y;
  // 越靠下，横向切口越粗，做出经典的复古落日
  float cut = smoothstep(0.0, 0.06, fract(y * 16.0 - uTime * 0.04) - (1.0 - y) * 0.75);
  float mask = disc * mix(1.0, cut, step(y, 0.58));
  vec3 col = mix(uAccent, uThird, y) * (1.1 + uBeat * 0.9);
  gl_FragColor = vec4(col * mask, 1.0);
}
`

function create(): VizScene {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 300)

  const history = new SpectrumHistory(COLS, ROWS, 45)
  const texture = new THREE.DataTexture(history.data, COLS, ROWS, THREE.RedFormat, THREE.FloatType)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.needsUpdate = true

  const uniforms = {
    uHistory: { value: texture },
    uHead: { value: 0 },
    uAccent: { value: new THREE.Color() },
    uSecond: { value: new THREE.Color() },
    uThird: { value: new THREE.Color() },
    uBeat: { value: 0 }
  }

  const geometry = new THREE.PlaneGeometry(52, 38, COLS - 1, ROWS - 1)
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, 0, -6)
  const terrain = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: terrainVertex,
      fragmentShader: terrainFragment
    })
  )
  terrain.frustumCulled = false
  scene.add(terrain)

  const sunUniforms = {
    uAccent: uniforms.uAccent,
    uThird: uniforms.uThird,
    uBeat: uniforms.uBeat,
    uTime: { value: 0 }
  }
  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.ShaderMaterial({
      uniforms: sunUniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: sunFragment,
      transparent: false
    })
  )
  sun.position.set(0, 9, -60)
  scene.add(sun)

  const starPositions = new Float32Array(1600 * 3)
  for (let i = 0; i < 1600; i++) {
    const r = 110 + Math.random() * 30
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(Math.random() * 0.95)
    starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    starPositions[i * 3 + 1] = r * Math.cos(phi) * 0.7 + 2
    starPositions[i * 3 + 2] = -Math.abs(r * Math.sin(phi) * Math.sin(theta)) - 20
  }
  const starGeometry = new THREE.BufferGeometry()
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
  const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({ size: 0.9, color: 0xffffff, transparent: true, opacity: 0.8, sizeAttenuation: false })
  )
  scene.add(stars)

  return {
    scene,
    camera,
    bloom: { strength: 0.7, radius: 0.5, threshold: 0.55 },
    update(a, p, input) {
      if (history.tick(a.dt, a.bands)) texture.needsUpdate = true
      uniforms.uHead.value = history.head
      uniforms.uAccent.value.copy(p.accent)
      uniforms.uSecond.value.copy(p.second)
      uniforms.uThird.value.copy(p.third)
      uniforms.uBeat.value = a.beat
      sunUniforms.uTime.value = a.time

      const t = a.time
      camera.position.set(
        Math.sin(t * 0.11) * 4 + input.pointer.x * 3,
        6.2 + a.bass * 1.4 - input.pointer.y * 1.5,
        17
      )
      camera.lookAt(0, 2.2, -5)
      camera.fov = 58 + a.beat * 4
      camera.updateProjectionMatrix()
      stars.rotation.y = t * 0.004
    },
    resize(w, h) {
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    },
    dispose() {
      texture.dispose()
      disposeScene(scene)
    }
  }
}

export const terrainScene: SceneDef = { id: 'terrain', name: '频谱山脉', hint: '复古落日下滚动的频谱地形', create }
