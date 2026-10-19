import { cityScene } from './city'
import { galaxyScene } from './galaxy'
import { orbScene } from './orb'
import { plasmaScene } from './plasma'
import { ribbonScene } from './ribbon'
import { terrainScene } from './terrain'
import { tunnelScene } from './tunnel'
import type { SceneDef } from './common'
import { instrumentScenes } from './instruments'

export { terrainScene }

export const SCENES: readonly SceneDef[] = [
  // 暂时隐藏频谱山脉，不删代码
  // terrainScene,
  orbScene,
  galaxyScene,
  tunnelScene,
  cityScene,
  ribbonScene,
  plasmaScene,
  ...instrumentScenes
]

export type { SceneDef, VizScene } from './common'
