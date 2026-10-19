import * as THREE from 'three'
import { GLSL_BANDS, GLSL_NOISE } from '../glsl'
import { colorRamp, disposeScene, sampleBand, TAU, type SceneDef, type VizScene } from './common'

const RING_BARS = 128
const BG = 0x04040a

const orbVertex = /* glsl */ `
${GLSL_NOISE}
${GLSL_BANDS}
uniform float uTime;
uniform float uBass;
uniform float uTreble;
uniform float uBeat;
varying vec3 vNormal;
varying vec3 vView;
varying float vDisp;

float dispAt(vec3 n){
  float lon = atan(n.z, n.x) / 6.2831853 + 0.5;
  float lat = abs(n.y);
  float spec = bandAt(abs(lon * 2.0 - 1.0));
  float s1 = snoise(n * 1.7 + uTime * 0.35);
  float s2 = snoise(n * 4.4 - uTime * 0.6);
  return s1 * (0.12 + uBass * 0.5) + s2 * (0.035 + uTreble * 0.3) + spec * 0.6 * (1.0 - lat * 0.45) + uBeat * 0.16;
}

void main(){
  vec3 n = normalize(position);
  float d0 = dispAt(n);
  vec3 t1 = normalize(cross(n, vec3(0.0, 1.0, 0.0013)));
  vec3 t2 = cross(n, t1);
  float eps = 0.025;
  vec3 n1 = normalize(n + t1 * eps);
  vec3 n2 = normalize(n + t2 * eps);
  vec3 p0 = n * (2.0 + d0);
  vec3 p1 = n1 * (2.0 + dispAt(n1));
  vec3 p2 = n2 * (2.0 + dispAt(n2));
  vec3 nrm = normalize(cross(p1 - p0, p2 - p0));
  if (dot(nrm, n) < 0.0) nrm = -nrm;

  vDisp = d0;
  vNormal = normalize(normalMatrix * nrm);
  vec4 mv = modelViewMatrix * vec4(p0, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`

const orbFragment = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uSecond;
uniform vec3 uThird;
uniform float uTime;
uniform float uBeat;
varying vec3 vNormal;
varying vec3 vView;
varying float vDisp;

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  float ndv = max(dot(N, V), 0.0);
  float fres = pow(1.0 - ndv, 2.4);
  float lit = max(dot(N, normalize(vec3(0.5, 0.8, 0.6))), 0.0);
  vec3 iri = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + vDisp * 1.6 + ndv * 0.7 + uTime * 0.05));
  vec3 base = mix(uAccent, uSecond, clamp(vDisp * 1.8 + 0.5, 0.0, 1.0));
  vec3 col = base * (0.12 + lit * 0.75);
  col += mix(uThird, iri, 0.55) * fres * (0.9 + uBeat * 1.2);
  col += base * max(vDisp, 0.0) * 1.0;
  gl_FragColor = vec4(col, 1.0);
}
`

function create(): VizScene {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300)

  const uniforms = {
    uBands: { value: new Float32Array(128) },
    uTime: { value: 0 },
    uBass: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uAccent: { value: new THREE.Color() },
    uSecond: { value: new THREE.Color() },
    uThird: { value: new THREE.Color() }
  }

  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 48),
    new THREE.ShaderMaterial({ uniforms, vertexShader: orbVertex, fragmentShader: orbFragment })
  )
  orb.frustumCulled = false
  scene.add(orb)

  const shellMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  const shell = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(3.3, 3)), shellMaterial)
  scene.add(shell)

  const barGeometry = new THREE.BoxGeometry(1, 1, 1)
  const barMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending })
  const bars = new THREE.InstancedMesh(barGeometry, barMaterial, RING_BARS)
  bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RING_BARS * 3), 3)
  bars.frustumCulled = false
  const ring = new THREE.Group()
  ring.add(bars)
  ring.rotation.x = 0.35
  scene.add(ring)

  const dustCount = 900
  const dust = new Float32Array(dustCount * 3)
  for (let i = 0; i < dustCount; i++) {
    const r = 6 + Math.random() * 26
    const theta = Math.random() * TAU
    const y = (Math.random() - 0.5) * 18
    dust[i * 3] = Math.cos(theta) * r
    dust[i * 3 + 1] = y
    dust[i * 3 + 2] = Math.sin(theta) * r
  }
  const dustGeometry = new THREE.BufferGeometry()
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dust, 3))
  const dustPoints = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.55, color: 0xffffff })
  )
  scene.add(dustPoints)

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const pos = new THREE.Vector3()
  const scl = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const tmp = new THREE.Color()

  return {
    scene,
    camera,
    bloom: { strength: 0.75, radius: 0.6, threshold: 0.5 },
    update(a, p, input) {
      uniforms.uBands.value.set(a.bands)
      uniforms.uTime.value = a.time
      uniforms.uBass.value = a.bass
      uniforms.uTreble.value = a.treble
      uniforms.uBeat.value = a.beat
      uniforms.uAccent.value.copy(p.accent)
      uniforms.uSecond.value.copy(p.second)
      uniforms.uThird.value.copy(p.third)

      shell.rotation.y = a.time * 0.08 + a.beat * 0.05
      shell.rotation.x = Math.sin(a.time * 0.1) * 0.3
      shell.scale.setScalar(1 + a.bass * 0.12 + a.beat * 0.05)
      shellMaterial.color.copy(p.second)
      shellMaterial.opacity = 0.12 + a.treble * 0.5

      ring.rotation.y = a.time * 0.12
      for (let i = 0; i < RING_BARS; i++) {
        const t = i / RING_BARS
        const v = sampleBand(a.bands, Math.abs(t * 2 - 1))
        const angle = t * TAU
        const height = 0.06 + v * 2.6
        pos.set(Math.cos(angle) * 4.7, 0, Math.sin(angle) * 4.7)
        q.setFromAxisAngle(up, -angle)
        scl.set(0.05, height, 0.05)
        m.compose(pos, q, scl)
        bars.setMatrixAt(i, m)
        colorRamp(tmp, p, Math.abs(t * 2 - 1)).multiplyScalar(0.55 + v * 1.4)
        bars.setColorAt(i, tmp)
      }
      bars.instanceMatrix.needsUpdate = true
      if (bars.instanceColor) bars.instanceColor.needsUpdate = true

      dustPoints.rotation.y = a.time * 0.015
      const orbit = a.time * 0.09
      camera.position.set(
        Math.sin(orbit) * 9.5 + input.pointer.x * 2,
        2.4 + Math.sin(a.time * 0.17) * 1.2 - input.pointer.y * 1.5,
        Math.cos(orbit) * 9.5
      )
      camera.lookAt(0, 0, 0)
    },
    resize(w, h) {
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    },
    dispose() {
      disposeScene(scene)
    }
  }
}

export const orbScene: SceneDef = { id: 'orb', name: '声波星球', hint: '随频谱起伏的流光行星与环形光柱', create }
