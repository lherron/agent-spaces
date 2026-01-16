/**
 * Harness types for Agent Spaces v2 Multi-Harness Support
 *
 * A Harness is a coding agent runtime (e.g., Claude Code, Pi).
 * Each harness implements a common interface for detection, validation,
 * materialization, composition, and invocation.
 */

import type { LockWarning } from './lock.js'
import type { SpaceKey, SpaceRefString } from './refs.js'
import type { ResolvedSpaceManifest, SpaceSettings } from './space.js'

// ============================================================================
// Harness Identification
// ============================================================================

/** Supported harness identifiers */
export type HarnessId = 'claude' | 'claude-agent-sdk' | 'pi' | 'pi-sdk'

/** All known harness IDs */
export const HARNESS_IDS: readonly HarnessId[] = [
  'claude',
  'claude-agent-sdk',
  'pi',
  'pi-sdk',
] as const

/** Type guard for HarnessId */
export function isHarnessId(value: string): value is HarnessId {
  return HARNESS_IDS.includes(value as HarnessId)
}

/** Default harness when none specified */
export const DEFAULT_HARNESS: HarnessId = 'claude'

// ============================================================================
// Harness Detection
// ============================================================================

/** Result of detecting a harness's availability */
export interface HarnessDetection {
  /** Whether the harness binary is available */
  available: boolean
  /** Harness version string if available */
  version?: string | undefined
  /** Path to the harness binary */
  path?: string | undefined
  /** Detected capabilities of this harness */
  capabilities?: string[] | undefined
  /** Error message if detection failed */
  error?: string | undefined
}

// ============================================================================
// Validation Types
// ============================================================================

/** Result of validating a space for a harness */
export interface HarnessValidationResult {
  /** Whether the space is valid for this harness */
  valid: boolean
  /** Validation errors (block materialization) */
  errors: string[]
  /** Validation warnings (allow materialization with warnings) */
  warnings: string[]
}

// ============================================================================
// Materialization Types
// ============================================================================

/** Input for materializing a single space */
export interface MaterializeSpaceInput {
  /** Space identifier (id@commit) */
  spaceKey: SpaceKey
  /** Resolved space manifest */
  manifest: ResolvedSpaceManifest
  /** Path to the space snapshot */
  snapshotPath: string
  /** Content integrity hash */
  integrity: string
}

/** Options for space materialization */
export interface MaterializeSpaceOptions {
  /** Force regeneration even if cached */
  force?: boolean | undefined
  /** Use hardlinks instead of copies (default: true). Set to false for dev mode to protect source files. */
  useHardlinks?: boolean | undefined
}

/** Result of materializing a single space */
export interface MaterializeSpaceResult {
  /** Path to the cached artifact */
  artifactPath: string
  /** Files in the artifact */
  files: string[]
  /** Warnings from materialization */
  warnings: string[]
}

// ============================================================================
// Target Composition Types
// ============================================================================

/** A resolved space with its artifact path for composition */
export interface ResolvedSpaceArtifact {
  /** Space key (id@commit) */
  spaceKey: SpaceKey
  /** Space identifier */
  spaceId: string
  /** Path to materialized artifact */
  artifactPath: string
  /** Plugin name */
  pluginName: string
  /** Plugin version */
  pluginVersion?: string | undefined
}

/** Input for composing a target */
export interface ComposeTargetInput {
  /** Target name */
  targetName: string
  /** Original compose list */
  compose: SpaceRefString[]
  /** Root space keys */
  roots: SpaceKey[]
  /** Load order (deps before dependents) */
  loadOrder: SpaceKey[]
  /** Resolved artifacts in load order */
  artifacts: ResolvedSpaceArtifact[]
  /** Settings inputs from all spaces */
  settingsInputs: SpaceSettings[]
}

/** Options for target composition */
export interface ComposeTargetOptions {
  /** Clean output directory before composition */
  clean?: boolean | undefined
  /** Inherit project-level settings (for Pi: enables .pi/skills in project) */
  inheritProject?: boolean | undefined
  /** Inherit user-level settings (for Pi: enables ~/.pi/agent/skills) */
  inheritUser?: boolean | undefined
}

/** Result of composing a target */
export interface ComposeTargetResult {
  /** The composed target bundle */
  bundle: ComposedTargetBundle
  /** Warnings from composition */
  warnings: LockWarning[]
}

// ============================================================================
// Composed Target Bundle
// ============================================================================

/** A fully composed target bundle ready for invocation */
export interface ComposedTargetBundle {
  /** Which harness this bundle is for */
  harnessId: HarnessId
  /** Target name */
  targetName: string
  /** Root directory of the bundle */
  rootDir: string

  // Claude-specific fields (populated by ClaudeAdapter)
  /** Ordered plugin directory paths */
  pluginDirs?: string[] | undefined
  /** Path to composed MCP config */
  mcpConfigPath?: string | undefined
  /** Path to composed settings */
  settingsPath?: string | undefined

  // Pi-specific fields (populated by PiAdapter)
  pi?: {
    /** Directory containing bundled extensions */
    extensionsDir: string
    /** Directory containing merged skills */
    skillsDir?: string | undefined
    /** Path to generated hook bridge extension */
    hookBridgePath?: string | undefined
    /** Path to run manifest */
    runManifestPath?: string | undefined
  }

  // Pi SDK-specific fields (populated by PiSdkAdapter)
  piSdk?: {
    /** Path to bundle.json manifest */
    bundleManifestPath: string
    /** Directory containing bundled extensions */
    extensionsDir: string
    /** Directory containing merged skills */
    skillsDir?: string | undefined
    /** Directory containing hook scripts */
    hooksDir?: string | undefined
    /** Directory containing context files */
    contextDir?: string | undefined
  }
}

// ============================================================================
// Control-Plane Context (for multi-agent coordination)
// ============================================================================

/**
 * Control-Plane context for multi-agent coordination.
 *
 * WHY: Multi-agent runs need coordination through the control-plane.
 * This context is extracted from environment variables and passed through
 * to harness adapters for inclusion in run events.
 */
export interface CpContext {
  /** Work item identifier (from CP_WORK_ITEM_ID) */
  workItemId?: string | undefined
  /** Run identifier (from CP_RUN_ID) */
  runId?: string | undefined
  /** Role name (from CP_ROLE) */
  role?: string | undefined
  /** Run kind (from CP_KIND) */
  kind?: string | undefined
  /** Distributed trace identifier (from CP_TRACE_ID) */
  traceId?: string | undefined
}

// ============================================================================
// Run Options
// ============================================================================

/** Options for building run arguments */
export interface HarnessRunOptions {
  /** Model override */
  model?: string | undefined
  /** Setting sources to inherit (Claude-specific) */
  settingSources?: string | null | undefined
  /** Additional CLI arguments */
  extraArgs?: string[] | undefined
  /** Whether to run in interactive mode */
  interactive?: boolean | undefined
  /** Project directory */
  projectPath?: string | undefined
  /** Working directory for harness execution */
  cwd?: string | undefined
  /** Prompt text for non-interactive mode */
  prompt?: string | undefined
  /** Disable hook blocking and permissions (YOLO mode) */
  yolo?: boolean | undefined
  /** Control-Plane context for multi-agent coordination */
  cpContext?: CpContext | undefined
  /** Path to artifact directory for run outputs (events, transcripts) */
  artifactDir?: string | undefined
  /** Whether to emit JSONL events to the artifact directory */
  emitEvents?: boolean | undefined
}

// ============================================================================
// Harness Adapter Interface
// ============================================================================

/**
 * HarnessAdapter interface
 *
 * Each coding agent harness implements this interface to support
 * multi-harness Agent Spaces.
 */
export interface HarnessAdapter {
  /** Harness identifier */
  readonly id: HarnessId

  /** Human-readable name */
  readonly name: string

  /**
   * Detect if the harness binary is available
   */
  detect(): Promise<HarnessDetection>

  /**
   * Validate that a space is compatible with this harness
   */
  validateSpace(input: MaterializeSpaceInput): HarnessValidationResult

  /**
   * Materialize a single space into a reusable, cacheable harness artifact.
   *
   * This produces a harness-specific representation of the space
   * (e.g., Claude plugin directory, Pi extension bundle).
   *
   * @param input - Space materialization input
   * @param cacheDir - Directory to write the artifact to
   * @param options - Materialization options
   */
  materializeSpace(
    input: MaterializeSpaceInput,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult>

  /**
   * Assemble a target bundle from ordered per-space artifacts.
   *
   * This composes multiple space artifacts into a single target bundle
   * ready for invocation.
   *
   * @param input - Target composition input
   * @param outputDir - Directory to write the bundle to
   * @param options - Composition options
   */
  composeTarget(
    input: ComposeTargetInput,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult>

  /**
   * Build CLI arguments for running the harness
   *
   * @param bundle - The composed target bundle
   * @param options - Run options
   */
  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[]

  /**
   * Get the output directory path for a target bundle
   *
   * @param aspModulesDir - Path to asp_modules directory
   * @param targetName - Target name
   */
  getTargetOutputPath(aspModulesDir: string, targetName: string): string
}

// ============================================================================
// Harness Manifest Extensions (for space.toml)
// ============================================================================

/** Harness support declaration in space.toml */
export interface SpaceHarnessConfig {
  /** List of harnesses this space supports */
  supports?: HarnessId[] | undefined
  /** Minimum harness version requirements */
  requires?: Partial<Record<HarnessId, string>> | undefined
}

/** Claude-specific configuration in space.toml */
export interface SpaceClaudeConfig {
  /** Model override for Claude */
  model?: string | undefined
  /** Explicit MCP config paths */
  mcp?: string[] | undefined
}

/** Pi build configuration in space.toml */
export interface SpacePiBuildConfig {
  /** Whether to bundle extensions (default: true) */
  bundle?: boolean | undefined
  /** Output format: "esm" or "cjs" */
  format?: 'esm' | 'cjs' | undefined
  /** Target runtime: "bun" or "node" */
  target?: 'bun' | 'node' | undefined
  /** Dependencies to exclude from bundle */
  external?: string[] | undefined
}

/** Pi-specific configuration in space.toml */
export interface SpacePiConfig {
  /** Model override for Pi */
  model?: string | undefined
  /** Explicit extension paths */
  extensions?: string[] | undefined
  /** Build configuration */
  build?: SpacePiBuildConfig | undefined
}

/** Extended space manifest with harness configuration */
export interface SpaceHarnessManifestExtension {
  /** Harness support declaration */
  harness?: SpaceHarnessConfig | undefined
  /** Claude-specific configuration */
  claude?: SpaceClaudeConfig | undefined
  /** Pi-specific configuration */
  pi?: SpacePiConfig | undefined
}
