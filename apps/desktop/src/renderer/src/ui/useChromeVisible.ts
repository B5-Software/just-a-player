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
    const pointers = new Set<number>()
    const wake = (): void => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (
          pointers.size ||
          document.querySelector('[data-app-dialog]') ||
          document.activeElement?.matches('textarea,input:not([type="range"]),:focus-visible')
        )
          wake()
        else setIdle(true)
      }, IDLE_MS)
    }
    const down = (event: PointerEvent): void => {
      pointers.add(event.pointerId)
      wake()
    }
    const up = (event: PointerEvent): void => {
      pointers.delete(event.pointerId)
      wake()
    }
    const blur = (): void => {
      pointers.clear()
      wake()
    }
    wake()
    window.addEventListener('pointermove', wake)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('focusin', wake)
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('focusin', wake)
      window.removeEventListener('blur', blur)
      window.removeEventListener('keydown', wake)
    }
  }, [enabled, panel])

  return !enabled || panel !== null || !idle
}
