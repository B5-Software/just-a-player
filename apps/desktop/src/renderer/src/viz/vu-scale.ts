// Program RMS, before the player's master volume. Keep 0 VU = -18 dBFS;
// modern masters need headroom beyond the +3 VU of an analog faceplate.
export const VU_TICKS = [-30, -20, -10, -5, 0, 3, 6, 12, 18] as const
export function vuPosition(rms: number): number {
  const dbfs = 20 * Math.log10(Math.max(1e-8, Math.abs(rms)))
  return Math.max(0, Math.min(1, (dbfs + 48) / 48))
}
// 99% of the final deflection after 300 ms; 300 ms is not the time constant.
export function smoothVu(current: number, target: number, seconds: number): number {
  return (
    current + (target - current) * (1 - Math.exp(-Math.max(0, seconds) / (0.3 / Math.log(100))))
  )
}
