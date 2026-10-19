import * as THREE from 'three'
import { GLSL_BANDS, GLSL_NOISE } from '../glsl'
import { type SceneDef, type VizScene } from './common'

const fragment = /* glsl */ `
${GLSL_NOISE}
${GLSL_BANDS}
uniform vec2 uRes;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;
uniform vec3 uAccent;
uniform vec3 uSecond;
uniform vec3 uThird;
uniform sampler2D uBackdrop;
uniform float uBackdropOn;
uniform float uBackdropGain;
varying vec2 vUv;

float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float map(vec3 p){
  float d = 1e5;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    vec3 c = vec3(sin(uTime * 0.55 + fi * 2.1), cos(uTime * 0.43 + fi * 1.7), sin(uTime * 0.37 + fi * 1.3)) * (1.5 + uMid * 0.9);
    float r = 0.5 + bandAt(fi / 7.0 * 0.6) * 0.7 + uBass * 0.25 + uBeat * 0.12;
    d = smin(d, length(p - c) - r, 0.95);
  }
  d += snoise(p * 2.2 + uTime * 0.4) * 0.04 * (0.3 + uTreble * 2.2);
  return d;
}

vec3 calcNormal(vec3 p){
  vec2 e = vec2(0.003, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)));
}

vec3 background(vec2 uv){
  vec3 col = uBackdropOn > 0.5
    ? texture2D(uBackdrop, vUv).rgb * uBackdropGain
    : mix(uAccent * 0.04, uSecond * 0.14, vUv.y);
  float a = snoise(vec3(uv * vec2(1.6, 1.0) + vec2(0.0, uTime * 0.05), uTime * 0.12));
  float b = snoise(vec3(uv * vec2(3.1, 2.0) - vec2(uTime * 0.04, 0.0), uTime * 0.09 + 7.0));
  float aurora = pow(max(a * 0.6 + b * 0.4, 0.0), 2.2);
  col += mix(uAccent, uThird, vUv.x) * aurora * (0.45 + uTreble * 2.0 + uBeat * 0.6);
  return col;
}

void main(){
  vec2 uv = (vUv * 2.0 - 1.0) * vec2(uRes.x / uRes.y, 1.0);
  vec3 ro = vec3(0.0, 0.0, 6.2);
  vec3 rd = normalize(vec3(uv, -1.9));
  float ang = uTime * 0.12;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  ro.xz = rot * ro.xz;
  rd.xz = rot * rd.xz;

  float t = 0.0;
  float glow = 0.0;
  bool hit = false;
  vec3 p = ro;
  for (int i = 0; i < 56; i++) {
    p = ro + rd * t;
    float d = map(p);
    glow += 0.012 / (0.05 + abs(d));
    if (d < 0.003) { hit = true; break; }
    t += d * 0.85;
    if (t > 14.0) break;
  }

  vec3 col = background(uv);
  if (hit) {
    vec3 n = calcNormal(p);
    vec3 V = -rd;
    float ndv = max(dot(n, V), 0.0);
    float fres = pow(1.0 - ndv, 3.0);
    vec3 iri = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + ndv * 0.9 + uTime * 0.05 + length(p) * 0.15));
    vec3 base = mix(uAccent, uSecond, 0.5 + 0.5 * n.y);
    vec3 l = normalize(vec3(0.6, 0.8, 0.5));
    float diff = max(dot(n, l), 0.0);
    float spec = pow(max(dot(reflect(-l, n), V), 0.0), 36.0);
    col = base * (0.14 + 0.86 * diff) + mix(iri, uThird, 0.4) * fres * (1.5 + uBeat * 1.5) + spec * 0.9;
  }
  col += glow * 0.045 * mix(uAccent, uThird, 0.5 + 0.5 * sin(uTime * 0.3));
  gl_FragColor = vec4(col, 1.0);
}
`

/** 没有封面时绑定的占位纹理，采样器必须始终有有效的贴图。 */
const EMPTY_TEXTURE = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
EMPTY_TEXTURE.needsUpdate = true

function create(): VizScene {
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const uniforms = {
    uBands: { value: new Float32Array(128) },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uAccent: { value: new THREE.Color() },
    uSecond: { value: new THREE.Color() },
    uThird: { value: new THREE.Color() },
    uBackdrop: { value: EMPTY_TEXTURE as THREE.Texture },
    uBackdropOn: { value: 0 },
    uBackdropGain: { value: 1 }
  }
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false
    })
  )
  quad.frustumCulled = false
  scene.add(quad)

  return {
    scene,
    camera,
    bloom: { strength: 0.55, radius: 0.7, threshold: 0.6 },
    update(a, p) {
      uniforms.uBands.value.set(a.bands)
      uniforms.uTime.value = a.time
      uniforms.uBass.value = a.bass
      uniforms.uMid.value = a.mid
      uniforms.uTreble.value = a.treble
      uniforms.uBeat.value = a.beat
      uniforms.uAccent.value.copy(p.accent)
      uniforms.uSecond.value.copy(p.second)
      uniforms.uThird.value.copy(p.third)
    },
    resize(w, h) {
      uniforms.uRes.value.set(w, h)
    },
    setBackdrop(texture, gain) {
      uniforms.uBackdrop.value = texture ?? EMPTY_TEXTURE
      uniforms.uBackdropOn.value = texture ? 1 : 0
      uniforms.uBackdropGain.value = gain
    },
    dispose() {
      quad.geometry.dispose()
      ;(quad.material as THREE.Material).dispose()
    }
  }
}

export const plasmaScene: SceneDef = { id: 'plasma', name: '熔岩极光', hint: '光线步进的流体熔岩球与极光', create }
