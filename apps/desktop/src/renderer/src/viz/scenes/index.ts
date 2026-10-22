import { create } from 'zustand'
import { useSettings } from '../../settings/store'
import { STUDIO_PLUGINS, COVER_PLUGIN } from '../plugins/studio'
import { shaderScene } from '../plugins/shader'
import type { SceneDef } from './common'
export type { SceneDef, VizScene } from './common'
export const studioScenes = STUDIO_PLUGINS.map((p) => shaderScene(p))
const cover = shaderScene(COVER_PLUGIN)
let legacy: SceneDef[] = []
let loading: Promise<unknown> | null = null
let key = ''
export let SCENES: readonly SceneDef[] = studioScenes
export const useSceneRegistry = create<{
  scenes: readonly SceneDef[]
  loading: boolean
  error: string
}>(() => ({ scenes: SCENES, loading: false, error: '' }))
function refresh(): void {
  const settings = useSettings.getState()
  const available = [
    ...studioScenes,
    ...settings.visualPlugins.map((p) => shaderScene(p, true)),
    ...legacy.filter((p) => settings.enabledLegacyVisuals.includes(p.id)),
  ]
  SCENES = available.filter((s) => !settings.disabledVisuals.includes(s.id))
  if (!SCENES.length) SCENES = [cover]
  useSceneRegistry.setState({ scenes: SCENES })
  if (settings.enabledLegacyVisuals.length && !legacy.length && !loading) {
    useSceneRegistry.setState({ loading: true, error: '' })
    loading = import('./legacy')
      .then((module) => {
        legacy = module.legacyScenes
        refresh()
      })
      .catch((e) => useSceneRegistry.setState({ error: String(e) }))
      .finally(() => {
        loading = null
        useSceneRegistry.setState({ loading: false })
      })
  }
}
function sync(): void {
  const s = useSettings.getState(),
    next = JSON.stringify([s.enabledLegacyVisuals, s.disabledVisuals, s.visualPlugins])
  if (next === key) return
  key = next
  refresh()
}
useSettings.subscribe(sync)
sync()
export async function prepareScenes(): Promise<void> {
  if (loading) await loading
}
