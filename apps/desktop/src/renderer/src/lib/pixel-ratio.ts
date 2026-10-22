/** Android page layout has its own scale; canvas resolution still follows physical pixels. */
export function surfacePixelRatio(): number {
  return (
    window.devicePixelRatio *
    (window.jap.platform === 'android' && window.jap.surface !== 'export'
      ? (window.visualViewport?.scale ?? 1)
      : 1)
  )
}
