import { create } from 'zustand'
import { LYRICS_FONTS, type ImportedFont, type LyricsFontId } from '@shared/settings'

export const useFontCatalog = create<{ imported: ImportedFont[] }>(() => ({
  imported: window.jap.initialFonts
}))
window.jap.onFonts((imported) => useFontCatalog.setState({ imported }))
const pending = new Map<string, Promise<void>>()
export function fontOf(id: LyricsFontId): {
  id: string
  label: string
  family: string
  weight: number
} {
  return (
    LYRICS_FONTS.find((f) => f.id === id) ??
    useFontCatalog.getState().imported.find((f) => f.id === id) ??
    LYRICS_FONTS[0]
  )
}
export function ensureFont(id: LyricsFontId): Promise<void> {
  const font = fontOf(id)
  if (!id.startsWith('user-'))
    return document.fonts.load(`${font.weight} 48px "${font.family}"`).then(() => {})
  let task = pending.get(id)
  if (!task) {
    task = window.jap
      .fontData(id)
      .then(async (bytes) => {
        if (!bytes) throw new Error(`字体文件已丢失：${font.label}`)
        const face = new FontFace(font.family, new Uint8Array(bytes), {
          weight: String(font.weight)
        })
        document.fonts.add(face)
        try {
          await face.load()
        } catch (error) {
          document.fonts.delete(face)
          throw error
        }
      })
      .catch((error) => {
        pending.delete(id)
        throw error
      })
    pending.set(id, task)
  }
  return task
}
export async function importFontFiles(): Promise<{ fonts: ImportedFont[]; errors: string[] }> {
  const result = await window.jap.importFonts()
  useFontCatalog.setState((s) => ({
    imported: [...new Map([...s.imported, ...result.fonts].map((f) => [f.id, f])).values()]
  }))
  await Promise.all(
    result.fonts.map((f) =>
      ensureFont(f.id).catch((e) => {
        result.errors.push(String(e))
      })
    )
  )
  return result
}
