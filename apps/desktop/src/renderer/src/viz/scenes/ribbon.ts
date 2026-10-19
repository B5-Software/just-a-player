import * as THREE from 'three'
import { VIZ } from '@shared/viz'
import { colorRamp, disposeScene, TAU, type SceneDef, type VizScene } from './common'

const TRAILS = 56
const POINTS = VIZ.gonioPoints
const STEP = 0.2
const BG = 0x03030a

function create(): VizScene {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200)

  // 每条轨迹是一帧立体声相位点（L/R 合成的利萨如图形），越老越往后退并淡出
  const trails: THREE.Line[] = []
  for (let i = 0; i < TRAILS; i++) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(POINTS * 3), 3))
    const material = new THREE.LineBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      color: 0xffffff
    })
    const line = new THREE.Line(geometry, material)
    line.frustumCulled = false
    trails.push(line)
    scene.add(line)
  }

  const rings: THREE.Mesh[] = []
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.2 + i * 1.1, 0.012, 8, 220), ringMaterial)
    ring.position.z = -4
    rings.push(ring)
    scene.add(ring)
  }

  const dust = new Float32Array(1200 * 3)
  for (let i = 0; i < 1200; i++) {
    const r = 4 + Math.random() * 30
    const t = Math.random() * TAU
    dust[i * 3] = Math.cos(t) * r
    dust[i * 3 + 1] = Math.sin(t) * r
    dust[i * 3 + 2] = -Math.random() * 40
  }
  const dustGeometry = new THREE.BufferGeometry()
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dust, 3))
  const dustMaterial = new THREE.PointsMaterial({
    size: 1.5,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  scene.add(new THREE.Points(dustGeometry, dustMaterial))

  const color = new THREE.Color()
  let acc = 0
  let cursor = 0
  let gain = 6
  const born = new Float32Array(TRAILS).fill(-1e9)

  return {
    scene,
    camera,
    bloom: { strength: 0.8, radius: 0.5, threshold: 0.45 },
    update(a, p, input) {
      // 自动增益：无论母带响不响，图形大小都保持相对稳定
      const level = Math.max(0.12, (a.peak[0] + a.peak[1]) * 0.5)
      gain += (4.2 / level - gain) * (1 - Math.exp(-a.dt * 2.5))
      gain = Math.min(gain, 28)

      acc += a.dt
      if (acc >= 1 / 40) {
        acc = 0
        cursor = (cursor + 1) % TRAILS
        const positions = trails[cursor]!.geometry.getAttribute('position') as THREE.BufferAttribute
        for (let i = 0; i < POINTS; i++) {
          const l = a.gonio[i * 2] ?? 0
          const r = a.gonio[i * 2 + 1] ?? 0
          positions.setXYZ(i, (l - r) * 0.7071 * gain, (l + r) * 0.7071 * gain * 0.8, 0)
        }
        positions.needsUpdate = true
        born[cursor] = a.time
      }

      for (let i = 0; i < TRAILS; i++) {
        const trail = trails[i]!
        const age = (cursor - i + TRAILS) % TRAILS
        const life = age / TRAILS
        trail.position.z = -age * STEP
        trail.rotation.z = age * 0.012 * Math.sin(a.time * 0.3)
        colorRamp(color, p, life)
        const brightness = Math.pow(1 - life, 1.6) * (0.35 + a.energy * 1.5 + a.beat * 0.6)
        const material = trail.material as THREE.LineBasicMaterial
        material.color.copy(color).multiplyScalar(brightness)
      }

      ringMaterial.color.copy(p.second)
      ringMaterial.opacity = 0.1 + a.treble * 0.9
      rings.forEach((ring, i) => {
        ring.rotation.x = a.time * (0.1 + i * 0.05) + a.bass
        ring.rotation.y = a.time * (0.07 - i * 0.03)
        ring.scale.setScalar(1 + a.beat * 0.1 * (i + 1))
      })
      dustMaterial.color.copy(p.third)

      const orbit = Math.sin(a.time * 0.14) * 0.9 + input.pointer.x * 0.6
      camera.position.set(Math.sin(orbit) * 9, 3.2 + Math.cos(a.time * 0.11) * 1.8 - input.pointer.y * 2, Math.cos(orbit) * 9 + 2)
      camera.lookAt(0, 0, -5.5)
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

export const ribbonScene: SceneDef = { id: 'ribbon', name: '相位丝带', hint: '立体声相位拖出的利萨如光带', create }
