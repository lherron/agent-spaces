/**
 * Harness module for Agent Spaces v2
 *
 * Provides the harness adapter pattern for multi-harness support.
 */

export { HarnessRegistry, SessionRegistry } from 'spaces-runtime'
export { ClaudeAdapter, claudeAdapter } from 'spaces-harness-claude'
export {
  ClaudeAgentSdkAdapter,
  claudeAgentSdkAdapter,
} from 'spaces-harness-claude'
export { CodexAdapter, codexAdapter } from 'spaces-harness-codex'
export {
  PiAdapter,
  piAdapter,
  detectPi,
  clearPiCache,
  findPiBinary,
  bundleExtension,
  discoverExtensions,
  generateHookBridgeCode,
  type PiInfo,
  type ExtensionBuildOptions,
  type HookDefinition,
} from 'spaces-harness-pi'

export { PiSdkAdapter, piSdkAdapter } from 'spaces-harness-pi-sdk/adapter'

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
import { register as registerPi } from 'spaces-harness-pi'
import { piSdkAdapter } from 'spaces-harness-pi-sdk/adapter'
import { HarnessRegistry, SessionRegistry, setSessionRegistry } from 'spaces-runtime'

export const harnessRegistry = new HarnessRegistry()
export const sessionRegistry = new SessionRegistry()

setSessionRegistry(sessionRegistry)

registerClaude({ harnesses: harnessRegistry, sessions: sessionRegistry })
registerPi({ harnesses: harnessRegistry, sessions: sessionRegistry })

// Register pi-sdk adapter eagerly (lightweight, no barrel deps).
// Session factory is NOT registered here — PiSession is always constructed
// directly by consumers via spaces-harness-pi-sdk/pi-session, avoiding
// the @mariozechner/pi-coding-agent barrel import at CLI startup.
harnessRegistry.register(piSdkAdapter)

// Codex harness adapter registered eagerly (session factory removed — CodexSession
// is constructed directly by consumers via spaces-harness-codex/codex-session).
harnessRegistry.register(codexAdapter)
