import type { PluginApi } from '@wb/sdk'

/** Mermaid theme variables built only from design tokens. */
export function mermaidTheme(api: Pick<PluginApi, 'design'>): Record<string, string> {
  const theme = api.design.theme()
  const c = theme.colors
  return {
    darkMode: 'true',
    background: 'transparent',
    fontFamily: api.design.font.sans,
    fontSize: `${api.design.typeSize(theme, 'md')}px`,
    primaryColor: c.surfaceStrong,
    primaryTextColor: c.textPrimary,
    primaryBorderColor: c.hairlineStrong,
    secondaryColor: c.surface,
    secondaryTextColor: c.textPrimary,
    secondaryBorderColor: c.hairline,
    tertiaryColor: c.surface,
    tertiaryTextColor: c.textSecondary,
    tertiaryBorderColor: c.hairline,
    lineColor: c.textSecondary,
    textColor: c.textPrimary,
    mainBkg: c.surfaceStrong,
    nodeBorder: c.hairlineStrong,
    clusterBkg: c.surface,
    clusterBorder: c.hairline,
    edgeLabelBackground: c.surfaceStrong,
    titleColor: c.textPrimary,
    actorBkg: c.surfaceStrong,
    actorBorder: c.hairlineStrong,
    actorTextColor: c.textPrimary,
    signalColor: c.textSecondary,
    signalTextColor: c.textPrimary,
    noteBkgColor: c.accentSoft,
    noteTextColor: c.textPrimary,
    noteBorderColor: c.accent,
  }
}
