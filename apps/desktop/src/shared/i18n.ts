import english from './locales/en.json'
export type Language = 'zh-CN' | 'en'
export function resolveLanguage(preference: string | undefined, system: string | undefined): Language {
  const tag = preference && preference !== 'system' ? preference : system ?? 'en'
  return /^zh(?:[-_]|$)/i.test(tag) ? 'zh-CN' : 'en'
}
const catalogue: Record<string, string> = english
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const patterns = Object.entries(catalogue).filter(([key]) => /\{\d+\}/.test(key))
  .sort(([a],[b]) => b.replace(/\{\d+\}/g,'').length - a.replace(/\{\d+\}/g,'').length).map(([key, value]) => {
  const slots: string[] = []
  const pattern = key.split(/(\{\d+\})/).map(part => /^\{\d+\}$/.test(part) ? (slots.push(part), '(.*?)') : escape(part)).join('')
  return { regex: new RegExp('^' + pattern + '$', 's'), value, slots }
})
/** Source keys and parameters stay separate from filenames, lyrics and metadata. */
export function translate(text: string, language: Language): string {
  if (language === 'zh-CN' || !/[\u3400-\u9fff]/.test(text)) return text
  const exact = catalogue[text]
  if (exact !== undefined) return exact
  const trimmed = text.trim()
  if (catalogue[trimmed]) return text.replace(trimmed, catalogue[trimmed]!)
  for (const {regex, value, slots} of patterns) {
    const match = regex.exec(trimmed)
    if (match) return value.replace(/\{\d+\}/g, slot => match[slots.indexOf(slot) + 1] ?? slot)
  }
  // Backend errors can contain an untranslated path before a translated cause.
  // Translate complete clauses only; never replace substrings of song names.
  if (text.includes('\n')) return text.split('\n').map(line => translate(line, language)).join('\n')
  if (text.includes(' · ')) return text.split(' · ').map(part => translate(part, language)).join(' · ')
  return text
}
