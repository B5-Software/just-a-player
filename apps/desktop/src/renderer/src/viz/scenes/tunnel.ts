import * as THREE from 'three'
import { colorRamp, disposeScene, glowTexture, mirror, SpectrumHistory, TAU, type SceneDef, type VizScene } from './common'

const RINGS = 72
const SEGMENTS = 192
const SPACING = 1.15
const LENGTH = RINGS * SPACING
const STREAKS = 2600
const BG = 0x03030a

function create(): VizScene {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 200)
  camera.position.set(0, 0, 2)

  const history = new SpectrumHistory(128, RINGS, 24)
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })

  const rings: THREE.LineLoop[] = []
  for (let j = 0; j < RINGS; j++) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEGMENTS * 3), 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SEGMENTS * 3), 3))
    const ring = new THREE.LineLoop(geometry, material)
    ring.frustumCulled = false
    rings.push(ring)
    scene.add(ring)
  }

  const streakPositions = new Float32Array(STREAKS * 3)
  const streakAngle = new Float32Array(STREAKS)
  const streakRadius = new Float32Array(STREAKS)
  for (let i = 0; i < STREAKS; i++) {
    streakAngle[i] = Math.random() * TAU
    streakRadius[i] = 0.8 + Math.pow(Math.random(), 0.6) * 7
    streakPositions[i * 3 + 2] = -Math.random() * LENGTH
  }
  const streakGeometry = new THREE.BufferGeometry()
  streakGeometry.setAttribute('position', new THREE.BufferAttribute(streakPositions, 3))
  const streakMaterial = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    color: 0xffffff
  })
  const streaks = new THREE.Points(streakGeometry, streakMaterial)
  streaks.frustumCulled = false
  scene.add(streaks)

  const glow = glowTexture()
  const beacon = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  )
  beacon.position.set(0, 0, -LENGTH * 0.98)
  scene.add(beacon)

  const tmp = new THREE.Color()

  return {
    scene,
    camera,
    bloom: { strength: 0.8, radius: 0.55, threshold: 0.5 },
    update(a, p, input) {
      history.tick(a.dt, a.bands)
      const frac = history.frac

      for (let j = 0; j < RINGS; j++) {
        // 越新的环越靠近尽头，整条隧道以 24 Hz 的节奏朝镜头涌来
        const z = -(LENGTH - (j + frac) * SPACING)
        const near = 1 - THREE.MathUtils.smoothstep(z, -4, -0.4)
        const far = THREE.MathUtils.smoothstep(z, -LENGTH, -LENGTH * 0.82)
        const fade = near * (0.15 + far * 0.85)
        const twist = j * 0.04 + a.time * 0.18
        const positions = rings[j]!.geometry.getAttribute('position') as THREE.BufferAttribute
        const colors = rings[j]!.geometry.getAttribute('color') as THREE.BufferAttribute
        colorRamp(tmp, p, (j / RINGS) * 0.9)
        for (let s = 0; s < SEGMENTS; s++) {
          const t = s / SEGMENTS
          const col = Math.round(mirror(t) * 127)
          const v = history.at(j, col)
          const radius = 2.4 + v * 3.1 + a.beat * 0.18
          const angle = t * TAU + twist
          positions.setXYZ(s, Math.cos(angle) * radius, Math.sin(angle) * radius * 0.82, z)
          const k = (0.18 + v * 1.7) * fade
          colors.setXYZ(s, tmp.r * k, tmp.g * k, tmp.b * k)
        }
        positions.needsUpdate = true
        colors.needsUpdate = true
      }

      const speed = (14 + a.energy * 40) * a.dt
      for (let i = 0; i < STREAKS; i++) {
        let z = (streakPositions[i * 3 + 2] ?? 0) + speed
        if (z > 1) z -= LENGTH
        streakPositions[i * 3] = Math.cos(streakAngle[i] ?? 0) * (streakRadius[i] ?? 1)
        streakPositions[i * 3 + 1] = Math.sin(streakAngle[i] ?? 0) * (streakRadius[i] ?? 1) * 0.82
        streakPositions[i * 3 + 2] = z
      }
      streakGeometry.attributes['position']!.needsUpdate = true
      streakMaterial.color.copy(p.second).lerp(new THREE.Color(1, 1, 1), 0.45)

      beacon.material.color.copy(p.third)
      beacon.scale.setScalar(10 + a.bass * 14 + a.beat * 12)
      beacon.material.opacity = 0.55 + a.beat * 0.45

      camera.position.set(input.pointer.x * 0.7, -input.pointer.y * 0.5, 2)
      camera.rotation.z = Math.sin(a.time * 0.21) * 0.18 + a.beat * 0.025
      camera.fov = 72 + a.beat * 5 + a.energy * 6
      camera.updateProjectionMatrix()
    },
    resize(w, h) {
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    },
    dispose() {
      glow.dispose()
      disposeScene(scene)
    }
  }
}

export const tunnelScene: SceneDef = { id: 'tunnel', name: '时空隧道', hint: '频谱历史拼成的光之隧道，向你冲来', create }
