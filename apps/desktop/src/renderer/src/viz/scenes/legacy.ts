import { legacyGpuScenes } from '../plugins/legacy-gpu'
import { cityScene } from './city'
import { galaxyScene } from './galaxy'
import { orbScene } from './orb'
import { plasmaScene } from './plasma'
import { ribbonScene } from './ribbon'
import { terrainScene } from './terrain'
import { tunnelScene } from './tunnel'

const originalThemes = new Map(
  [orbScene, galaxyScene, tunnelScene, cityScene, ribbonScene, plasmaScene, terrainScene].map(
    (scene) => [scene.id, scene] as const
  )
)

export const legacyScenes = legacyGpuScenes.map((shader) => {
  const original = originalThemes.get(shader.id)
  return original ? { ...shader, create: original.create, createNative: shader.create } : shader
})
