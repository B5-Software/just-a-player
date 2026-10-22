let androidSurfaceWidth = 0

/** Native view pixels remain authoritative when WebView's density cache is stale. */
export function setAndroidSurfaceWidth(width: number): void {
  androidSurfaceWidth = width
}

/** Android page layout has its own scale; canvas resolution still follows physical pixels. */
export function surfacePixelRatio(): number {
  if (window.jap.platform === 'android' && window.jap.surface !== 'export') {
    const width = window.visualViewport?.width ?? window.innerWidth
    if (androidSurfaceWidth > 0 && width > 0) return androidSurfaceWidth / width
  }
  return (
    window.devicePixelRatio *
    (window.jap.platform === 'android' && window.jap.surface !== 'export'
      ? (window.visualViewport?.scale ?? 1)
      : 1)
  )
}
