import { useVideoQueue } from '../video/export'
export function VideoQueuePanel(): React.JSX.Element {
  const jobs = useVideoQueue((s) => s.jobs)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-fg-muted">
        后台逐个导出，可继续听歌、切换效果与使用播放器。每个任务使用加入队列时保存的画面与歌词设置。
      </p>
      {jobs.length === 0 && (
        <p className="py-8 text-center text-sm text-fg-muted">还没有导出任务</p>
      )}
      {[...jobs].reverse().map((j) => (
        <article key={j.id} className="rounded-2xl bg-hover p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{j.title}</p>
              <p className="mt-1 break-all text-[11px] text-fg-muted">{j.target}</p>
            </div>
            {(j.state === 'waiting' || j.state === 'rendering') && (
              <button
                type="button"
                className="shrink-0 rounded-lg px-2 py-1 text-xs hover:bg-surface"
                onClick={() => window.jap.cancelVideoJob(j.id)}
              >
                取消
              </button>
            )}
          </div>
          <progress value={j.progress} max={1} className="mt-3 h-1.5 w-full accent-accent" />
          <p className="mt-2 text-xs text-fg-muted">{j.status}</p>
          {j.error && <p className="mt-2 break-words text-xs text-fidelity-lossy">{j.error}</p>}
        </article>
      ))}
    </div>
  )
}
