import { useEffect, useState } from 'react'
import { useSettings } from '../settings/store'
import { useViz } from '../viz/store'
import { useUi } from './store'

const IDLE_MS = 3000

/**
 * 顶栏与控制坞是否可见。全屏时自动隐藏始终开启；窗口模式取决于设置（默认关闭）。
 * 打开了面板时保持可见。
 */
export function useChromeVisible(): boolean {
  const fullscreen = useViz((s) => s.fullscreen)
  const autoHide = useSettings((s) => s.autoHideControls)
  const panel = useUi((s) => s.panel)
  const enabled = fullscreen || autoHide
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    if (!enabled || panel) {
      setIdle(false)
      return
    }
    let timer = 0
    const wake = (): void => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), IDLE_MS)
    }
    wake()
    window.addEventListener('pointermove', wake)
    window.addEventListener('keydown', wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [enabled, panel])

  return !enabled || panel !== null || !idle
}
