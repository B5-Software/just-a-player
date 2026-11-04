/** Typed arrays keep their representation over the local audio-service socket. */
export function encodeAudioMessage(value: unknown): string {
  return JSON.stringify(value, function (key, value) {
    const original = this[key]
    if (ArrayBuffer.isView(original)) {
      return {
        binary: original instanceof Float32Array ? 'f32' : 'u8',
        data: Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString('base64'),
      }
    }
    return value
  }) + '\n'
}

export function decodeAudioMessage(text: string): unknown {
  return JSON.parse(text, (_key, value) => {
    if ((value?.binary === 'f32' || value?.binary === 'u8') && typeof value.data === 'string') {
      const bytes = Buffer.from(value.data, 'base64')
      return value.binary === 'f32'
        ? new Float32Array(Uint8Array.from(bytes).buffer)
        : new Uint8Array(bytes)
    }
    return value
  })
}
