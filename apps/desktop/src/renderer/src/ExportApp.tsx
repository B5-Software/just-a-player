import { useEffect } from 'react'
import { Visualizer } from './components/Visualizer'
import { LyricsLayer } from './lyrics/LyricsLayer'
import { renderVideoJob, useVideoExport } from './video/export'
import { useSettings } from './settings/store'
import { useViz } from './viz/store'
import { prepareScenes } from './viz/scenes'
if (window.jap.surface === 'export') {
  window.jap.onVideoCancel(() => useVideoExport.setState({ cancel: true }))
  window.jap.onVideoJob((job) => {
    useSettings.setState(job.settings)
    const offset = job.visual.viewport
      ? {
          x: (job.visual.offset.x * job.options.width) / job.visual.viewport.width,
          y: (job.visual.offset.y * job.options.height) / job.visual.viewport.height,
          z: job.visual.offset.z,
        }
      : job.visual.offset
    useViz.setState({ ...job.visual, offset, auto: false })
    let previous = -1
    let reportedAt = 0
    const unsubscribe = useVideoExport.subscribe((value) => {
      if (
        value.running &&
        value.progress < 1 &&
        value.progress - previous < 0.01 &&
        Date.now() - reportedAt < 1000 &&
        value.error === null
      )
        return
      previous = value.progress
      reportedAt = Date.now()
      window.jap.videoProgress({ id: job.id, ...value })
    })
    const heartbeat = setInterval(() => {
      const value = useVideoExport.getState()
      if (value.running) window.jap.videoProgress({ id: job.id, ...value })
    }, 1000)
    void prepareScenes()
      .then(() => renderVideoJob({ ...job.options, queueId: job.id }))
      .finally(() => {
        clearInterval(heartbeat)
        unsubscribe()
      })
  })
}
export function ExportApp(): React.JSX.Element {
  useEffect(() => {
    window.jap.videoWorkerReady()
  }, [])
  return (
    <div className="absolute inset-0" style={{ opacity: 0 }}>
      <Visualizer />
      <LyricsLayer />
    </div>
  )
}
