import type { Fidelity } from '@shared/protocol/Fidelity'
import { usePlayer } from '../engine/store'
import { TONE_CLASS, VERDICT_LABEL } from '../lib/verdict'

const DOT: Record<Fidelity, string> = {
  exact: 'bg-fidelity-exact shadow-[0_0_10px_rgb(var(--fidelity-exact)/0.8)]',
  transformed: 'bg-fidelity-transformed shadow-[0_0_10px_rgb(var(--fidelity-transformed)/0.8)]',
  lossy: 'bg-fidelity-lossy shadow-[0_0_10px_rgb(var(--fidelity-lossy)/0.8)]'
}

const FIDELITY_TEXT: Record<Fidelity, string> = {
  exact: '逐位透传',
  transformed: '样本被改变',
  lossy: '有损'
}

/** 实时信号链（浮层内容）：从文件到 DAC 的每一步，以及每一步有没有动过样本。 */
export function SignalPathPanel(): React.JSX.Element {
  const path = usePlayer((s) => s.signalPath)
  const verdict = path ? VERDICT_LABEL[path.verdict] : null

  return (
    <div className="flex flex-col gap-4">
      {verdict && (
        <span
          className={`self-start rounded-full px-2.5 py-1 text-xs font-semibold ring-1 m-0.5 ${TONE_CLASS[verdict.tone]}`}
        >
          {verdict.text}
        </span>
      )}

      {path ? (
        <ol className="relative flex flex-col gap-0.5 pr-1">
          {path.nodes.map((node, i) => (
            <li
              key={`${i}-${node.kind}-${node.title}`}
              className="relative flex gap-3.5 pb-4 last:pb-0"
            >
              <div className="flex flex-col items-center pt-1.5 pl-1.5 pr-0.5">
                <span className={`size-2.5 shrink-0 rounded-full ${DOT[node.fidelity]}`} />
                {i < path.nodes.length - 1 && <span className="mt-1.5 w-px flex-1 bg-line" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium">{node.title}</span>
                  <span className="shrink-0 text-[11px] text-fg-subtle">
                    {FIDELITY_TEXT[node.fidelity]}
                  </span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{node.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-fg-subtle">
          开始播放后，这里会显示音频到达耳机之前经过的每一步。
        </p>
      )}
    </div>
  )
}
