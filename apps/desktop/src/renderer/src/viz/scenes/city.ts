import * as THREE from 'three'
import { colorRamp, disposeScene, mirror, SpectrumHistory, TAU, type SceneDef, type VizScene } from './common'

const GRID = 27
const GAP = 1.2
const SPARKS = 700
const BG = 0x04030c

function create(): VizScene {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  scene.fog = new THREE.FogExp2(BG, 0.022)
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 300)

  const history = new SpectrumHistory(128, GRID, 20)
  const count = GRID * GRID

  const box = new THREE.BoxGeometry(0.86, 1, 0.86)
  box.translate(0, 0.5, 0)
  const solid = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff }), count)
  const mirrored = new THREE.InstancedMesh(
    box,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
    count
  )
  for (const mesh of [solid, mirrored]) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
    mesh.frustumCulled = false
    scene.add(mesh)
  }

  const floor = new THREE.GridHelper(GRID * GAP * 2.4, 72, 0xffffff, 0xffffff)
  const floorMaterial = floor.material as THREE.LineBasicMaterial
  floorMaterial.transparent = true
  floorMaterial.opacity = 0.18
  floorMaterial.depthWrite = false
  floor.position.y = 0.002
  scene.add(floor)

  const sparkPositions = new Float32Array(SPARKS * 3)
  const sparkSpeed = new Float32Array(SPARKS)
  const span = GRID * GAP
  for (let i = 0; i < SPARKS; i++) {
    sparkPositions[i * 3] = (Math.random() - 0.5) * span * 1.3
    sparkPositions[i * 3 + 1] = Math.random() * 16
    sparkPositions[i * 3 + 2] = (Math.random() - 0.5) * span * 1.3
    sparkSpeed[i] = 0.5 + Math.random() * 1.5
  }
  const sparkGeometry = new THREE.BufferGeometry()
  sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3))
  const sparkMaterial = new THREE.PointsMaterial({
    size: 2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    color: 0xffffff
  })
  scene.add(new THREE.Points(sparkGeometry, sparkMaterial))

  const matrix = new THREE.Matrix4()
  const color = new THREE.Color()
  const center = (GRID - 1) / 2
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const position = new THREE.Vector3()

  return {
    scene,
    camera,
    bloom: { strength: 0.6, radius: 0.5, threshold: 0.6 },
    update(a, p, input) {
      history.tick(a.dt, a.bands)

      for (let iz = 0; iz < GRID; iz++) {
        for (let ix = 0; ix < GRID; ix++) {
          const index = iz * GRID + ix
          // 左右对称：中间是低频，两侧是高频；前后方向是时间，最前排最新
          const col = Math.round(mirror(ix / (GRID - 1)) * 127)
          const v = history.at(iz, col)
          const height = 0.12 + Math.pow(v, 1.7) * 8 * (1 + a.beat * 0.12)

          position.set((ix - center) * GAP, 0, (center - iz) * GAP)
          scale.set(1, height, 1)
          matrix.compose(position, quat, scale)
          solid.setMatrixAt(index, matrix)

          scale.set(1, -height * 0.6, 1)
          matrix.compose(position, quat, scale)
          mirrored.setMatrixAt(index, matrix)

          colorRamp(color, p, Math.min(1, v * 1.25)).multiplyScalar(0.12 + v * 0.55)
          solid.setColorAt(index, color)
          mirrored.setColorAt(index, color)
        }
      }
      for (const mesh of [solid, mirrored]) {
        mesh.instanceMatrix.needsUpdate = true
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      }

      floorMaterial.color.copy(p.accent)
      floorMaterial.opacity = 0.12 + a.beat * 0.35
      sparkMaterial.color.copy(p.third)
      const rise = (0.6 + a.energy * 5) * a.dt
      for (let i = 0; i < SPARKS; i++) {
        let y = (sparkPositions[i * 3 + 1] ?? 0) + rise * (sparkSpeed[i] ?? 1)
        if (y > 16) y = 0
        sparkPositions[i * 3 + 1] = y
      }
      sparkGeometry.attributes['position']!.needsUpdate = true

      const angle = Math.sin(a.time * 0.1) * 0.7 + input.pointer.x * 0.35
      const radius = 27 - a.bass * 2
      camera.position.set(Math.sin(angle) * radius, 12 + Math.sin(a.time * 0.16) * 2 - input.pointer.y * 2, Math.cos(angle) * radius)
      camera.lookAt(0, 2.2, 0)
      void TAU
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

export const cityScene: SceneDef = { id: 'city', name: '光之都市', hint: '会呼吸的霓虹摩天楼群与倒影', create }
