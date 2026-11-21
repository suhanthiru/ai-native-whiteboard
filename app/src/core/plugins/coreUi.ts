import type { CoreUi } from '@wb/sdk'
import { useBusLatest } from '../bus'
import { useTheme } from '../design/theme'
import { GlassPanel, Text } from '../design/ui'
import { Enter, Reveal } from '../motion'

/** UI building blocks plugins get through api.ui. */
export const coreUi: CoreUi = { GlassPanel, Text, Enter, Reveal, useTheme, useBusLatest }
