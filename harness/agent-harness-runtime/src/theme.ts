import { Theme } from '@earendil-works/pi-coding-agent'

export const RESOURCE_LOADER_THEME_NAME = 'praesidium-loader'

const foregrounds = {
  accent: '#22d3ee',
  border: '#a855f7',
  borderAccent: '#22d3ee',
  borderMuted: '#6b21a8',
  success: '#86efac',
  error: '#fca5a5',
  warning: '#fde047',
  muted: '#c4b5fd',
  dim: '#a78bfa',
  text: '#f8fafc',
  thinkingText: '#c4b5fd',
  searchMatchText: '#ffffff',
  userMessageText: '#ffffff',
  customMessageText: '#ffffff',
  customMessageLabel: '#67e8f9',
  toolTitle: '#ffffff',
  toolOutput: '#cffafe',
  mdHeading: '#67e8f9',
  mdLink: '#c4b5fd',
  mdLinkUrl: '#a5f3fc',
  mdCode: '#67e8f9',
  mdCodeBlock: '#d8b4fe',
  mdCodeBlockBorder: '#22d3ee',
  mdQuote: '#e9d5ff',
  mdQuoteBorder: '#a855f7',
  mdHr: '#6b21a8',
  mdListBullet: '#22d3ee',
  toolDiffAdded: '#86efac',
  toolDiffRemoved: '#fca5a5',
  toolDiffContext: '#c4b5fd',
  syntaxComment: '#a5b4fc',
  syntaxKeyword: '#67e8f9',
  syntaxFunction: '#d8b4fe',
  syntaxVariable: '#f8fafc',
  syntaxString: '#a7f3d0',
  syntaxNumber: '#fde68a',
  syntaxType: '#c4b5fd',
  syntaxOperator: '#67e8f9',
  syntaxPunctuation: '#f8fafc',
  thinkingOff: '#6b21a8',
  thinkingMinimal: '#7e22ce',
  thinkingLow: '#9333ea',
  thinkingMedium: '#a855f7',
  thinkingHigh: '#c084fc',
  thinkingXhigh: '#22d3ee',
  thinkingMax: '#67e8f9',
  bashMode: '#22d3ee',
} satisfies ConstructorParameters<typeof Theme>[0]

const backgrounds = {
  selectedBg: '#0e7490',
  scrollbarThumb: '#22d3ee',
  searchMatchBg: '#7e22ce',
  userMessageBg: '#6d28d9',
  customMessageBg: '#581c87',
  toolPendingBg: '#155e75',
  toolSuccessBg: '#166534',
  toolErrorBg: '#991b1b',
} satisfies ConstructorParameters<typeof Theme>[1]

export function createResourceLoaderTheme(sourcePath: string): Theme {
  return new Theme(foregrounds, backgrounds, 'truecolor', {
    name: RESOURCE_LOADER_THEME_NAME,
    sourcePath,
  })
}
