import { cloneElement, isValidElement, useSyncExternalStore, type ReactNode } from 'react'
import { translate, resolveLanguage, type Language } from '@shared/i18n'
import { useSettings } from './settings/store'

let language = resolveLanguage(useSettings.getState().language, window.jap.systemLocale ?? navigator.language)
const subscribers = new Set<() => void>()
const setLanguage = (): void => {
  const next = resolveLanguage(useSettings.getState().language, window.jap.systemLocale ?? navigator.language)
  document.documentElement.lang = next
  if (next === language) return
  language = next
  for (const listener of subscribers) listener()
}
setLanguage()
useSettings.subscribe(setLanguage)
window.addEventListener('languagechange', setLanguage)
export function useLocale(): Language {
  return useSyncExternalStore(subscribe, () => language)
}
function subscribe(listener: () => void): () => void { subscribers.add(listener); return () => { subscribers.delete(listener) } }
export const t = (text: string): string => translate(text, language)
const textProps = ['title','label','hint','placeholder','aria-label','aria-description','description','message','emptyText']
/** Localize UI presentation during React render. IDs, values, event handlers,
 * track metadata and translate="no" subtrees are preserved. No DOM mutation. */
export function ui<T>(node: T): T {
  if (language === 'zh-CN') return node
  if (typeof node === 'string') return t(node) as T
  if (Array.isArray(node)) {
    const children = node.map(child => ui(child))
    return (children.some((child, i) => child !== node[i]) ? children : node) as T
  }
  if (!isValidElement<Record<string, unknown>>(node) || node.props['translate'] === 'no') return node
  const patch: Record<string, unknown> = {}
  for (const key of typeof node.type === 'string' || typeof node.type === 'object' ? textProps : []) {
    const value = node.props[key]
    if (typeof value === 'string') {
      const localized = t(value)
      if (localized !== value) patch[key] = localized
    }
  }
  const children = ui(node.props['children'] as ReactNode)
  if (children !== node.props['children']) patch['children'] = children
  return Object.keys(patch).length ? cloneElement(node, patch) as T : node
}
