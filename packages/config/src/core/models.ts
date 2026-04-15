/**
 * Canonical Claude model identifiers.
 *
 * Single source of truth for all model strings used across packages.
 */

// ---------------------------------------------------------------------------
// Full model IDs (as recognized by the API / Claude CLI)
// ---------------------------------------------------------------------------
export const CLAUDE_OPUS_4_6 = 'claude-opus-4-6'
export const CLAUDE_OPUS_4_6_1M = 'claude-opus-4-6[1m]'
export const CLAUDE_SONNET_4_5 = 'claude-sonnet-4-5'
export const CLAUDE_HAIKU_4_5 = 'claude-haiku-4-5'
export const CLAUDE_HAIKU_3_5 = 'claude-haiku-3-5'

// ---------------------------------------------------------------------------
// Short aliases (accepted by Claude Code CLI --model flag)
// ---------------------------------------------------------------------------
export const ALIAS_OPUS = 'opus'
export const ALIAS_OPUS_1M = 'opus[1m]'
export const ALIAS_SONNET = 'sonnet'
export const ALIAS_HAIKU = 'haiku'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
export const DEFAULT_CLAUDE_CODE_MODEL = ALIAS_OPUS_1M
export const DEFAULT_AGENT_SDK_MODEL = 'claude/sonnet'

// ---------------------------------------------------------------------------
// Model lists by harness / frontend
// ---------------------------------------------------------------------------
export const CLAUDE_CODE_MODELS: string[] = [
  CLAUDE_OPUS_4_6,
  CLAUDE_OPUS_4_6_1M,
  CLAUDE_SONNET_4_5,
  CLAUDE_HAIKU_4_5,
  ALIAS_OPUS,
  ALIAS_OPUS_1M,
  ALIAS_SONNET,
  ALIAS_HAIKU,
]

export const AGENT_SDK_MODELS: string[] = [
  'claude/opus',
  'claude/haiku',
  'claude/sonnet',
  `claude/${CLAUDE_OPUS_4_6}`,
]

// ---------------------------------------------------------------------------
// Alias → full-ID translation maps
// ---------------------------------------------------------------------------

/** Maps short Agent SDK model names to full SDK model identifiers. */
export const AGENT_SDK_MODEL_MAP: Readonly<Record<string, string>> = {
  haiku: CLAUDE_HAIKU_3_5,
  sonnet: CLAUDE_SONNET_4_5,
  opus: CLAUDE_OPUS_4_6,
  'opus-4-6': CLAUDE_OPUS_4_6,
}

/** Maps Claude-style aliases to Pi-style model identifiers. */
export const PI_MODEL_TRANSLATION: Readonly<Record<string, string>> = {
  sonnet: 'claude-sonnet',
  opus: 'claude-opus',
  haiku: 'claude-haiku',
  'sonnet-4': CLAUDE_SONNET_4_5,
  'sonnet-4-5': CLAUDE_SONNET_4_5,
  'opus-4': CLAUDE_OPUS_4_6,
  'opus-4-6': CLAUDE_OPUS_4_6,
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

export type AgentSdkModelAlias = 'haiku' | 'sonnet' | 'opus' | 'opus-4-6'

export function normalizeAgentSdkModel(model: string): AgentSdkModelAlias {
  switch (model) {
    case 'haiku':
    case 'sonnet':
    case 'opus':
    case 'opus-4-6':
      return model
    case CLAUDE_OPUS_4_6:
    case CLAUDE_OPUS_4_6_1M:
    case ALIAS_OPUS_1M:
      return 'opus-4-6'
    default:
      throw new Error(`Unsupported agent-sdk model: ${model}`)
  }
}
