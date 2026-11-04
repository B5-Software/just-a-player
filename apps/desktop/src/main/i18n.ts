import { app } from 'electron'
import { getSettings } from './settings'
import { resolveLanguage, translate } from '../shared/i18n'
export const tMain = (text: string): string => translate(text, resolveLanguage(getSettings().language, process.env['JAP_E2E_LOCALE'] || app.getPreferredSystemLanguages()[0] || app.getLocale()))
