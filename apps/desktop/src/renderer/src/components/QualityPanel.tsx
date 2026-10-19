import { useQuality } from '../audio/quality-store'
import { usePlayer } from '../engine/store'
import { Toggle } from '../ui/controls'

export function QualityPanel(): React.JSX.Element {
  const report = useQuality((s) => s.report)
  const pending = useQuality((s) => s.pending)
  const error = useQuality((s) => s.error)
  const automatic = useQuality((s) => s.automatic)
  const hasTrack = usePlayer((s) => s.track !== null)
  const confidence: Record<string, string> = { high: '高置信', medium: '中置信', low: '低置信' }
  const metrics = report
    ? [
        ['样本峰值', `${report.peakDbfs.toFixed(2)} dBFS`],
        ['平均 RMS', `${report.rmsDbfs.toFixed(1)} dBFS`],
        ['峰均比', `${report.crestDb.toFixed(1)} dB`],
        ['疑似削波段', String(report.clippedRuns)],
        ['安静窗口 RMS', `${report.quietRmsDbfs.toFixed(1)} dBFS`],
        ['有效整数位', report.effectiveBits ? `${report.effectiveBits} bit` : '无法判断'],
        ['99.99% 能量带宽', `${(report.occupiedBandwidthHz / 1000).toFixed(1)} kHz`],
        ['声道相关系数', report.stereoCorrelation.toFixed(3)],
        ['直流偏移', `${(report.dcOffset * 100).toFixed(4)}%`],
        ['20 kHz 以上能量比', `${report.highBandDb.toFixed(1)} dB`]
      ]
    : []
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Toggle
            label="切歌自动分析"
            checked={automatic}
            onChange={(value) => useQuality.getState().setAutomatic(value)}
          />
          切歌自动分析
        </div>
        <button
          type="button"
          disabled={!hasTrack || !!pending}
          onClick={() => useQuality.getState().analyze()}
          className="rounded-xl bg-hover px-3 py-2 text-xs disabled:opacity-40"
        >
          {pending ? '分析中…' : '重新分析'}
        </button>
      </div>
      <p className="text-xs leading-relaxed text-fg-muted">
        直接检查解码样本中的满幅连续段、有效低位、能量带宽、安静窗口和声道关系。分析在独立工作线程中运行。
      </p>
      {!hasTrack && (
        <p className="py-8 text-center text-sm text-fg-muted">播放一首曲目以检查音源</p>
      )}
      {pending && (
        <p role="status" className="rounded-xl bg-hover p-4 text-sm text-fg-muted">
          正在多位置取样与计算频谱…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-fidelity-lossy">
          {error}
        </p>
      )}
      {report && (
        <>
          <div className="rounded-2xl border border-accent/30 bg-accent/10 p-4">
            <div className="flex items-end gap-2">
              <strong className="font-display text-4xl text-accent">{report.score ?? '—'}</strong>
              <span className="pb-1 text-xs text-fg-muted">/ 100 · 技术完整性</span>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-fg-muted">
              {report.scoreExplanation}
            </p>
          </div>
          <p className="text-[11px] text-fg-muted">
            已分析 {report.analyzedSeconds.toFixed(1)} 秒 · {report.coverage}
          </p>
          <dl className="grid grid-cols-2 gap-2">
            {metrics.map(([label, value]) => (
              <div key={label} className="rounded-xl bg-hover p-3">
                <dt className="text-[11px] text-fg-muted">{label}</dt>
                <dd className="mt-1 font-mono text-sm">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-3">
            {report.findings.map((finding) => (
              <article
                key={finding.title}
                className={`rounded-xl border p-3 ${finding.severity === 'warning' ? 'border-fidelity-transformed/40' : 'border-line'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold">{finding.title}</h3>
                  <span className="shrink-0 text-[10px] text-fg-muted">
                    {confidence[finding.confidence] ?? finding.confidence}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-fg-muted">{finding.detail}</p>
              </article>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-fg-muted">
            分数衡量已抽样信号的技术完整性，不代表音乐审美或录音来源认证。噪声可能属于录音内容，抽样不能保证整首无异常，也不能证明是否经过
            AI 升频。
          </p>
        </>
      )}
    </div>
  )
}
