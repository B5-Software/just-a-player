import { useEffect, useRef } from 'react'
import { VizHost } from '../viz/VizHost'
export let activeVizHost: VizHost | null = null

/** WebGL 画布容器；渲染器的生命周期与组件同步，StrictMode 下的重复挂载也能干净收尾。 */
export function Visualizer(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = new VizHost(ref.current!)
    activeVizHost = host
    // 端到端测试需要直接观察渲染器状态（比如指针缓动）
    if (new URLSearchParams(location.search).has('e2e')) {
      ;(window as unknown as Record<string, unknown>)['__japViz'] = host
    }
    return () => {
      activeVizHost = null
      host.dispose()
    }
  }, [])

  return <div ref={ref} className="absolute inset-0" />
}
