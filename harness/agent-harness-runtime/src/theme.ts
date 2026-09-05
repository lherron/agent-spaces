import { Theme } from '@earendil-works/pi-coding-agent'

export const RESOURCE_LOADER_THEME_NAME = 'praesidium-loader'

type Foregrounds = ConstructorParameters<typeof Theme>[0]
type Backgrounds = ConstructorParameters<typeof Theme>[1]

/** Resolved colors from Pi's bundled `modes/interactive/theme/dark.json`. */
const piDarkForegrounds = {
  accent: '#8abeb7',
  border: '#5f87ff',
  borderAccent: '#00d7ff',
  borderMuted: '#505050',
  success: '#b5bd68',
  error: '#cc6666',
  warning: '#ffff00',
  muted: '#808080',
  dim: '#666666',
  text: '#d4d4d4',
  thinkingText: '#808080',
  scrollbarTrack: '#505050',
  scrollbarThumb: '#d4d4d4',
  searchMatchText: '#d4d4d4',
  userMessageText: '#d4d4d4',
  customMessageText: '#d4d4d4',
  customMessageLabel: '#9575cd',
  toolTitle: '#d4d4d4',
  toolOutput: '#808080',
  mdHeading: '#f0c674',
  mdLink: '#81a2be',
  mdLinkUrl: '#666666',
  mdCode: '#8abeb7',
  mdCodeBlock: '#b5bd68',
  mdCodeBlockBorder: '#808080',
  mdQuote: '#808080',
  mdQuoteBorder: '#808080',
  mdHr: '#808080',
  mdListBullet: '#8abeb7',
  toolDiffAdded: '#b5bd68',
  toolDiffRemoved: '#cc6666',
  toolDiffContext: '#808080',
  syntaxComment: '#6a9955',
  syntaxKeyword: '#569cd6',
  syntaxFunction: '#dcdcaa',
  syntaxVariable: '#9cdcfe',
  syntaxString: '#ce9178',
  syntaxNumber: '#b5cea8',
  syntaxType: '#4ec9b0',
  syntaxOperator: '#d4d4d4',
  syntaxPunctuation: '#d4d4d4',
  thinkingOff: '#505050',
  thinkingMinimal: '#6e6e6e',
  thinkingLow: '#5f87af',
  thinkingMedium: '#81a2be',
  thinkingHigh: '#b294bb',
  thinkingXhigh: '#d183e8',
  thinkingMax: '#ff5fff',
  bashMode: '#b5bd68',
} satisfies Foregrounds

const piDarkBackgrounds = {
  selectedBg: '#3a3a4a',
  searchMatchBg: '#3a3a4a',
  userMessageBg: '#343541',
  customMessageBg: '#2d2838',
  toolPendingBg: '#282832',
  toolSuccessBg: '#283228',
  toolErrorBg: '#3c2828',
} satisfies Backgrounds

// Keep the harness identity at the interaction boundary; all other tokens use Pi dark.
const foregroundOverrides = {
  // Submitted user-message foreground.
  userMessageText: '#ffffff',
  // Input editor borders: inactive plus each active thinking/bash mode.
  borderMuted: '#6b21a8',
  thinkingOff: '#6b21a8',
  thinkingMinimal: '#7e22ce',
  thinkingLow: '#9333ea',
  thinkingMedium: '#a855f7',
  thinkingHigh: '#c084fc',
  thinkingXhigh: '#22d3ee',
  thinkingMax: '#67e8f9',
  bashMode: '#22d3ee',
  // Footer and transient status text.
  dim: '#a78bfa',
} satisfies Partial<Foregrounds>

const backgroundOverrides = {
  // Submitted user-message background.
  userMessageBg: '#6d28d9',
} satisfies Partial<Backgrounds>

export function createResourceLoaderTheme(sourcePath: string): Theme {
  return new Theme(
    { ...piDarkForegrounds, ...foregroundOverrides },
    { ...piDarkBackgrounds, ...backgroundOverrides },
    'truecolor',
    { name: RESOURCE_LOADER_THEME_NAME, sourcePath }
  )
}
