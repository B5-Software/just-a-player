import type { Verdict } from '@shared/protocol/Verdict'

export const VERDICT_LABEL: Record<Verdict, { text: string; tone: 'exact' | 'transformed' | 'lossy' }> = {
  bitPerfect: { text: 'Bit-Perfect', tone: 'exact' },
  processed: { text: '无损 · 已处理', tone: 'transformed' },
  lossy: { text: '有损源', tone: 'lossy' },
  systemMixed: { text: '系统混音', tone: 'transformed' }
}

export const TONE_CLASS = {
  exact: 'bg-fidelity-exact/15 text-fidelity-exact ring-fidelity-exact/30',
  transformed: 'bg-fidelity-transformed/15 text-fidelity-transformed ring-fidelity-transformed/30',
  lossy: 'bg-fidelity-lossy/15 text-fidelity-lossy ring-fidelity-lossy/30'
} as const
