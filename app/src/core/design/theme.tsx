import { createContext, useContext, type ReactNode } from 'react'
import { font, radius, space, themes, typeSize, type Theme, type ThemeName } from '@wb/sdk'
import { cssTransition, durations } from '@wb/sdk'

/** Write the theme's tokens as CSS variables so stylesheets never hardcode values. */
export function themeToCssVars(theme: Theme): Record<string, string> {
  const c = theme.colors
  return {
    '--wb-bg': c.background,
    '--wb-stage': c.stage,
    '--wb-surface': c.surface,
    '--wb-surface-strong': c.surfaceStrong,
    '--wb-hairline': c.hairline,
    '--wb-hairline-strong': c.hairlineStrong,
    '--wb-text': c.textPrimary,
    '--wb-text-2': c.textSecondary,
    '--wb-text-3': c.textTertiary,
    '--wb-accent': c.accent,
    '--wb-accent-soft': c.accentSoft,
    '--wb-danger': c.danger,
    '--wb-success': c.success,
    '--wb-blur': theme.blur,
    '--wb-shadow': theme.shadow,
    '--wb-shadow-soft': theme.shadowSoft,
    '--wb-hairline-w': `${theme.hairlineWidth}px`,
    '--wb-font': font.sans,
    '--wb-mono': font.mono,
    '--wb-fs-xs': `${typeSize(theme, 'xs')}px`,
    '--wb-fs-sm': `${typeSize(theme, 'sm')}px`,
    '--wb-fs-md': `${typeSize(theme, 'md')}px`,
    '--wb-fs-lg': `${typeSize(theme, 'lg')}px`,
    '--wb-fs-xl': `${typeSize(theme, 'xl')}px`,
    '--wb-fs-display': `${typeSize(theme, 'display')}px`,
    '--wb-fw-regular': String(font.weight.regular),
    '--wb-fw-medium': String(font.weight.medium),
    '--wb-fw-semibold': String(font.weight.semibold),
    '--wb-r-sm': `${radius.sm}px`,
    '--wb-r-md': `${radius.md}px`,
    '--wb-r-lg': `${radius.lg}px`,
    '--wb-s1': `${space[1]}px`,
    '--wb-s2': `${space[2]}px`,
    '--wb-s3': `${space[3]}px`,
    '--wb-s4': `${space[4]}px`,
    '--wb-s5': `${space[5]}px`,
    '--wb-s6': `${space[6]}px`,
    '--wb-t-fast': `${durations.fast}ms`,
    '--wb-t-base': `${durations.base}ms`,
    '--wb-transition': cssTransition('all', 'fast'),
  }
}

export function applyTheme(name: ThemeName, root: HTMLElement = document.documentElement): Theme {
  const theme = themes[name]
  for (const [key, value] of Object.entries(themeToCssVars(theme))) root.style.setProperty(key, value)
  root.dataset.theme = name
  return theme
}

const ThemeContext = createContext<Theme>(themes.glass)

interface ThemeProviderProps {
  theme: Theme
  children: ReactNode
}

export function ThemeProvider({ theme, children }: ThemeProviderProps) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}
