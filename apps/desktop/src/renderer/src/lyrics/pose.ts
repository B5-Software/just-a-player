import type { LyricsPose, LyricsPosition, LyricsRotation } from '@shared/settings'

const DEG = Math.PI / 180

/** 姿态目标，单位弧度；欧拉顺序为 ZXY：先偏航，再俯仰，最后绕视线滚转。 */
export interface PoseTarget {
  x: number
  y: number
  z: number
}

export const POSE_OPTIONS: readonly { id: LyricsPose; label: string }[] = [
  { id: 'auto', label: '跟随位置' },
  { id: 'none', label: '不旋转' },
  { id: 'top-cw', label: '俯视 · Z 顺时针' },
  { id: 'top-ccw', label: '俯视 · Z 逆时针' },
  { id: 'tilt', label: '后仰' },
  { id: 'sphere', label: '球形旋转' },
  { id: 'free', label: '自定义 XYZ' }
]

/** `auto` 时按位置决定实际姿态：居中不转，偏右俯视 Z 顺时针，偏左俯视 Z 逆时针，底部后仰。 */
export function effectivePose(
  pose: LyricsPose,
  position: LyricsPosition
): Exclude<LyricsPose, 'auto'> {
  if (pose !== 'auto') return pose
  switch (position) {
    case 'right':
      return 'top-cw'
    case 'left':
      return 'top-ccw'
    case 'bottom':
      return 'tilt'
    default:
      return 'none'
  }
}

export function resolvePose(
  pose: LyricsPose,
  position: LyricsPosition,
  rotation: LyricsRotation,
  spin: number,
  timeSec: number
): PoseTarget {
  switch (effectivePose(pose, position)) {
    // 俯角不宜太陡：字形在 -50° 时仍有约 2/3 的高度可读
    case 'top-cw':
      return { x: -50 * DEG, y: 0, z: -35 * DEG }
    case 'top-ccw':
      return { x: -50 * DEG, y: 0, z: 35 * DEG }
    case 'tilt':
      return { x: -22 * DEG, y: 0, z: 0 }
    case 'sphere': {
      const rate = 0.15 + spin * 0.85
      return {
        x: (-18 + 14 * Math.sin(timeSec * 0.37)) * DEG,
        y: timeSec * rate,
        z: 8 * Math.sin(timeSec * 0.21) * DEG
      }
    }
    case 'free':
      return { x: rotation.x * DEG, y: rotation.y * DEG, z: rotation.z * DEG }
    default:
      return { x: 0, y: 0, z: 0 }
  }
}
