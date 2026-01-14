/**
 * Harness module for Agent Spaces v2
 *
 * Provides the harness adapter pattern for multi-harness support.
 */

export { HarnessRegistry, harnessRegistry } from './registry.js'
export { ClaudeAdapter, claudeAdapter } from './claude-adapter.js'
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
} from './pi-adapter.js'

// Re-export types from core
export type {
  ComposedTargetBundle,
  ComposeTargetInput,
  ComposeTargetOptions,
  ComposeTargetResult,
  HarnessAdapter,
  HarnessDetection,
  HarnessId,
  HarnessRunOptions,
  HarnessValidationResult,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
  ResolvedSpaceArtifact,
} from 'spaces-core'

export { DEFAULT_HARNESS, HARNESS_IDS, isHarnessId } from 'spaces-core'

import { claudeAdapter } from './claude-adapter.js'
import { piAdapter } from './pi-adapter.js'
// Initialize the registry with built-in adapters
import { harnessRegistry } from './registry.js'

// Register built-in adapters
harnessRegistry.register(claudeAdapter)
harnessRegistry.register(piAdapter)
