/**
 * Harness module for Agent Spaces v2
 *
 * Provides the harness adapter pattern for multi-harness support.
 */

export { HarnessRegistry, SessionRegistry } from 'spaces-runtime'
export { ClaudeAdapter, claudeAdapter } from 'spaces-harness-claude'
export { CodexAdapter, codexAdapter } from 'spaces-harness-codex'
export { MuseAdapter, museAdapter } from 'spaces-harness-muse'
export { PiAdapter, piAdapter as agentHarnessAdapter } from 'spaces-harness-pi'

// Re-export types from core
export type {
  ComposedTargetBundle,
  ComposeTargetInput,
  ComposeTargetOptions,
  ComposeTargetResult,
  HarnessAdapter,
  HarnessDetection,
  HarnessId,
  HarnessModelInfo,
  HarnessRunOptions,
  HarnessValidationResult,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
  ResolvedSpaceArtifact,
} from 'spaces-config'

export { DEFAULT_HARNESS, HARNESS_IDS, isHarnessId } from 'spaces-config'

import { register as registerClaude } from 'spaces-harness-claude'
import { codexAdapter } from 'spaces-harness-codex'
import { museAdapter } from 'spaces-harness-muse'
import { piAdapter as agentHarnessAdapter } from 'spaces-harness-pi'
import { HarnessRegistry, SessionRegistry, setSessionRegistry } from 'spaces-runtime'

export const harnessRegistry = new HarnessRegistry()
export const sessionRegistry = new SessionRegistry()

setSessionRegistry(sessionRegistry)

registerClaude({ harnesses: harnessRegistry, sessions: sessionRegistry })
harnessRegistry.register(agentHarnessAdapter)

// Codex harness adapter registered eagerly (session factory removed — CodexSession
// is constructed directly by consumers via spaces-harness-codex/codex-session).
harnessRegistry.register(codexAdapter)

// Muse harness adapter registered eagerly (T-08591; no session factory —
// `muse exec` is a one-shot CLI driven through buildRunArgs).
harnessRegistry.register(museAdapter)
