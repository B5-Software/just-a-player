import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { applySettingsPatch, DEFAULT_SETTINGS, type AppSettings } from '../shared/settings'

let cache: AppSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  if (!cache) {
    try {
      cache = applySettingsPatch(DEFAULT_SETTINGS, JSON.parse(readFileSync(settingsPath(), 'utf8')))
    } catch {
      cache = { ...DEFAULT_SETTINGS }
    }
  }
  return cache
}

/** 只合并传入的字段并整体写回，避免改一项时把其他设置覆盖掉。 */
export function updateSettings(patch: unknown): AppSettings {
  cache = applySettingsPatch(getSettings(), patch)
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(cache, null, 2))
  } catch (error) {
    console.error('[settings] 保存失败', error)
  }
  return cache
}
