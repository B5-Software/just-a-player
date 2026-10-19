/** 歌词、播放列表这类文本：先按 UTF-8 解，失败再回退 GBK（老的 LRC 文件常见）。 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gbk').decode(bytes)
  }
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '')
}
