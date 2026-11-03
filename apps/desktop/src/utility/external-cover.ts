export interface ExternalCover { mime: string; data: Uint8Array }
export const MAX_COVER_BYTES = 8 * 1024 * 1024

/** A CDN may call JPEG image/jpg or application/octet-stream. Trust the
 * bounded raster header, not the spelling of its Content-Type. */
export function rasterCover(data: Uint8Array): ExternalCover {
  let mime = ''
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) mime = 'image/jpeg'
  else if (data.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => data[i] === n)) mime = 'image/png'
  else if (data.length >= 12 && [82,73,70,70].every((n,i) => data[i] === n) && [87,69,66,80].every((n,i) => data[i+8] === n)) mime = 'image/webp'
  if (!mime || data.length > MAX_COVER_BYTES) throw new Error('封面不是受支持的图片或超过内存预算')
  return { mime, data }
}

export async function responseCover(response: Response): Promise<ExternalCover> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`封面下载失败 (${response.status})`) }
  const length = Number(response.headers.get('content-length'))
  if (length > MAX_COVER_BYTES) { await response.body?.cancel(); throw new Error('封面超过内存预算') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('封面响应为空')
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > MAX_COVER_BYTES) throw new Error('封面超过内存预算')
      parts.push(next.value)
    }
  } finally { await reader.cancel() }
  return rasterCover(Buffer.concat(parts, size))
}
