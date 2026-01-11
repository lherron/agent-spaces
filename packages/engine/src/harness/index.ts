/**
 * Harness module for Agent Spaces v2
 *
 * Provides the harness adapter pattern for multi-harness support.
 */

export { HarnessRegistry, harnessRegistry } from './registry.js'
export { ClaudeAdapter, claudeAdapter } from './claude-adapter.js'

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
} from '@agent-spaces/core'

export { DEFAULT_HARNESS, HARNESS_IDS, isHarnessId } from '@agent-spaces/core'

import { claudeAdapter } from './claude-adapter.js'
// Initialize the registry with built-in adapters
import { harnessRegistry } from './registry.js'

// Register built-in adapters
harnessRegistry.register(claudeAdapter)
