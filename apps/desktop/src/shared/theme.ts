export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

/** 窗口外壳（背景与系统标题栏按钮）使用的颜色，需与渲染层 CSS 的底色保持一致。 */
export const CHROME = {
  dark: { background: '#07070b', symbol: '#d6d6de' },
  light: { background: '#f3f3f8', symbol: '#2a2a36' }
} as const
