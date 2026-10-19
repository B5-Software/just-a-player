import { useEffect } from 'react'
import { Visualizer } from './components/Visualizer'
import { LyricsLayer } from './lyrics/LyricsLayer'
import { renderVideoJob, useVideoExport } from './video/export'
import { useSettings } from './settings/store'
import { useViz } from './viz/store'
if (window.jap.surface === 'export') {
  window.jap.onVideoCancel(() => useVideoExport.setState({ cancel: true }))
  window.jap.onVideoJob((job) => {
    useSettings.setState(job.settings)
    useViz.setState({ ...job.visual, auto: false })
    let previous = -1
    const unsubscribe = useVideoExport.subscribe((value) => {
      if (
        value.running &&
        value.progress < 1 &&
        value.progress - previous < 0.01 &&
        value.error === null
      )
        return
      previous = value.progress
      window.jap.videoProgress({ id: job.id, ...value })
    })
    void renderVideoJob({ ...job.options, queueId: job.id }).finally(unsubscribe)
  })
}
export function ExportApp(): React.JSX.Element {
  useEffect(() => {
    window.jap.videoWorkerReady()
  }, [])
  return (
    <div className="absolute inset-0">
      <Visualizer />
      <LyricsLayer />
    </div>
  )
}
