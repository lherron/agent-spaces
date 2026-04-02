/**
 * Placement types for agent-spaces v2.
 *
 * RuntimePlacement is the primary input for placement-driven resolution.
 * See AGENT_SPACES_PLAN.md section 2.
 */

import type { RunMode } from './agent-profile.js'
import type { SpaceRefString } from './refs.js'

/** Scaffold packet injected by the host at run time */
export interface RunScaffoldPacket {
  slot: string
  content?: string | undefined
  ref?: string | undefined
  contentType?: 'markdown' | 'json' | 'text' | undefined
  version?: string | undefined
}

/** Bundle selector — determines which spaces compose the runtime */
export type RuntimeBundleRef =
  | { kind: 'agent-default' }
  | { kind: 'agent-target'; target: string }
  | { kind: 'project-target'; projectRoot: string; target: string }
  | { kind: 'agent-project'; agentName: string; projectRoot?: string | undefined }
  | { kind: 'compose'; compose: SpaceRefString[] }

/** Optional host correlation metadata */
export interface HostCorrelation {
  hostSessionId?: string | undefined
  runId?: string | undefined
  sessionRef?: { scopeRef: string; laneRef: string } | undefined
}

/** Primary input for placement-driven resolution */
export interface RuntimePlacement {
  agentRoot: string
  projectRoot?: string | undefined
  cwd?: string | undefined
  runMode: RunMode
  bundle: RuntimeBundleRef
  scaffoldPackets?: RunScaffoldPacket[] | undefined
  correlation?: HostCorrelation | undefined
  /** When true, skip strict validation (e.g. missing SOUL.md) for invocation building */
  dryRun?: boolean | undefined
}

// ============================================================================
// Helpers
// ============================================================================

const VALID_RUN_MODES = new Set(['query', 'heartbeat', 'task', 'maintenance'])
const VALID_BUNDLE_KINDS = new Set([
  'agent-default',
  'agent-target',
  'project-target',
  'agent-project',
  'compose',
])

/** Check if a string is a valid RunMode */
export function isValidRunMode(value: string): boolean {
  return VALID_RUN_MODES.has(value)
}

/** Check if a string is a valid RuntimeBundleRef kind */
export function isValidBundleRefKind(value: string): boolean {
  return VALID_BUNDLE_KINDS.has(value)
}

/** Create a RuntimePlacement with defaults applied */
export function createRuntimePlacement(input: RuntimePlacement): RuntimePlacement {
  return { ...input }
}

// ============================================================================
// Audit output types (AGENT_SPACES_PLAN.md section 11)
// ============================================================================

/** A resolved instruction with content hash for audit */
export interface ResolvedInstruction {
  slot: string
  ref: string
  contentHash: string
}

/** A resolved space with integrity for audit */
export interface ResolvedSpace {
  ref: string
  resolvedKey: string
  integrity: string
}

/** The complete resolved runtime bundle — audit output from resolution */
export interface ResolvedRuntimeBundle {
  bundleIdentity: string
  runMode: RunMode
  cwd: string
  instructions: ResolvedInstruction[]
  spaces: ResolvedSpace[]
}
