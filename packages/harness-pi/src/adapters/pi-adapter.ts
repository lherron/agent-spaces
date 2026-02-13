/**
 * PiAdapter - Harness adapter for Pi Coding Agent
 *
 * Implements the HarnessAdapter interface for Pi, supporting:
 * - Extension bundling with Bun
 * - Skills directory handling (Agent Skills standard)
 * - Hook bridge generation for shell scripts
 * - Tool namespacing
 */

import { readdirSync } from 'node:fs'
import { constants, access, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import {
  AspError,
  type ComposeTargetInput,
  type ComposeTargetOptions,
  type ComposeTargetResult,
  type ComposedTargetBundle,
  type HarnessAdapter,
  type HarnessDetection,
  type HarnessModelInfo,
  type HarnessRunOptions,
  type HarnessValidationResult,
  type LockWarning,
  type MaterializeSpaceInput,
  type MaterializeSpaceOptions,
  type MaterializeSpaceResult,
  type ProjectManifest,
  copyDir,
  linkOrCopy,
} from 'spaces-config'
import { WARNING_CODES } from 'spaces-config'
import {
  PERMISSIONS_TOML_FILENAME,
  hasPermissions,
  linkInstructionsFile,
  permissionsTomlExists,
  readHooksWithPrecedence,
  readPermissionsToml,
  toPiPermissions,
} from 'spaces-config'

// ============================================================================
// Pi-specific Errors
// ============================================================================

/** Error thrown when Pi binary is not found */
export class PiNotFoundError extends AspError {
  constructor(searchedPaths: string[]) {
    super(`Pi CLI not found. Searched: ${searchedPaths.join(', ')}`, 'PI_NOT_FOUND_ERROR')
    this.name = 'PiNotFoundError'
  }
}

/** Error thrown when Pi extension bundling fails */
export class PiBundleError extends AspError {
  readonly extensionPath: string
  readonly stderr: string

  constructor(extensionPath: string, stderr: string) {
    super(`Failed to bundle Pi extension "${extensionPath}": ${stderr}`, 'PI_BUNDLE_ERROR')
    this.name = 'PiBundleError'
    this.extensionPath = extensionPath
    this.stderr = stderr
  }
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Common locations to search for the Pi binary.
 */
const COMMON_PI_PATHS = [
  // Primary location
  join(process.env['HOME'] || '~', 'tools/pi-mono/packages/cli/bin/pi.js'),
  // Alternative locations
  join(process.env['HOME'] || '~', 'tools/pi-mono'),
  '/usr/local/bin/pi',
  '/usr/bin/pi',
  join(process.env['HOME'] || '~', '.local/bin/pi'),
]

/**
 * Component directories Pi handles from spaces.
 */
const _PI_COMPONENT_DIRS = ['extensions', 'skills', 'hooks', 'scripts', 'shared'] as const

/**
 * Model name translation from Claude-style to Pi-style.
 */
const MODEL_TRANSLATION: Record<string, string> = {
  sonnet: 'claude-sonnet',
  opus: 'claude-opus',
  haiku: 'claude-haiku',
  'sonnet-4': 'claude-sonnet-4-5',
  'sonnet-4-5': 'claude-sonnet-4-5',
  'opus-4': 'claude-opus-4-6',
  'opus-4-6': 'claude-opus-4-6',
}

/**
 * Events that Pi can support blocking on (none currently - best-effort only).
 */
const PI_BLOCKING_EVENTS: string[] = []

// ============================================================================
// Detection Utilities
// ============================================================================

/**
 * Cached Pi info to avoid repeated detection.
 */
let cachedPiInfo: PiInfo | null = null

/**
 * Information about the detected Pi installation.
 */
export interface PiInfo {
  /** Absolute path to the Pi binary */
  path: string
  /** Pi version string */
  version: string
  /** Whether extensions are supported */
  supportsExtensions: boolean
  /** Whether skills are supported */
  supportsSkills: boolean
}

/**
 * Check if a file exists and is executable.
 */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Search PATH for the Pi binary.
 */
async function searchPath(): Promise<string | null> {
  const pathEnv = process.env['PATH'] || ''
  const pathDirs = pathEnv.split(':')

  for (const dir of pathDirs) {
    const piPath = join(dir, 'pi')
    if (await isExecutable(piPath)) {
      return piPath
    }
  }

  return null
}

/**
 * Find the Pi binary location.
 *
 * Priority:
 * 1. PI_PATH environment variable
 * 2. PATH environment variable
 * 3. Common installation locations
 */
export async function findPiBinary(): Promise<string> {
  const searchedPaths: string[] = []

  // 1. Check PI_PATH environment variable
  const envPath = process.env['PI_PATH']
  if (envPath) {
    searchedPaths.push(envPath)
    if (await isExecutable(envPath)) {
      return envPath
    }
    // If PI_PATH is set but not found, throw immediately
    throw new PiNotFoundError(searchedPaths)
  }

  // 2. Search PATH
  const pathResult = await searchPath()
  if (pathResult) {
    return pathResult
  }

  // 3. Check common locations
  for (const commonPath of COMMON_PI_PATHS) {
    searchedPaths.push(commonPath)
    if (await isExecutable(commonPath)) {
      return commonPath
    }
    // Also check if it's a .js file that can be run with node/bun
    if (commonPath.endsWith('.js') && (await fileExists(commonPath))) {
      return commonPath
    }
  }

  throw new PiNotFoundError(searchedPaths)
}

/**
 * Query Pi version by running `pi --version`.
 */
async function queryPiVersion(piPath: string): Promise<string> {
  try {
    // If it's a .js file, run with bun
    const command = piPath.endsWith('.js') ? ['bun', piPath, '--version'] : [piPath, '--version']

    const proc = Bun.spawn(command, {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()

    if (exitCode !== 0) {
      return 'unknown'
    }

    // Parse version from output
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? (stdout.trim() || 'unknown')
  } catch {
    return 'unknown'
  }
}

/**
 * Check if a specific flag is supported by running `pi --help`.
 */
async function supportsPiFlag(piPath: string, flag: string): Promise<boolean> {
  try {
    const command = piPath.endsWith('.js') ? ['bun', piPath, '--help'] : [piPath, '--help']

    const proc = Bun.spawn(command, {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()

    const helpText = stdout + stderr
    return helpText.includes(flag)
  } catch {
    // If --help fails, assume flags are supported (conservative)
    return true
  }
}

/**
 * Detect Pi installation and query capabilities.
 */
export async function detectPi(forceRefresh = false): Promise<PiInfo> {
  if (cachedPiInfo && !forceRefresh) {
    return cachedPiInfo
  }

  const path = await findPiBinary()
  const version = await queryPiVersion(path)

  // Check supported flags in parallel
  const [supportsExtensions, supportsSkills] = await Promise.all([
    supportsPiFlag(path, '--extension'),
    supportsPiFlag(path, '--skills'),
  ])

  cachedPiInfo = {
    path,
    version,
    supportsExtensions,
    supportsSkills,
  }

  return cachedPiInfo
}

/**
 * Clear the cached Pi info.
 */
export function clearPiCache(): void {
  cachedPiInfo = null
}

// ============================================================================
// Extension Bundling
// ============================================================================

/**
 * Build options for extension bundling.
 */
export interface ExtensionBuildOptions {
  /** Output format: "esm" or "cjs" */
  format?: 'esm' | 'cjs' | undefined
  /** Target runtime: "bun" or "node" */
  target?: 'bun' | 'node' | undefined
  /** Dependencies to exclude from bundle */
  external?: string[] | undefined
}

/**
 * Bundle a TypeScript extension to JavaScript using Bun.
 *
 * @param srcPath - Source TypeScript file path
 * @param outPath - Output JavaScript file path
 * @param options - Build options
 */
export async function bundleExtension(
  srcPath: string,
  outPath: string,
  options: ExtensionBuildOptions = {}
): Promise<void> {
  const { format = 'esm', target = 'bun', external = [] } = options

  // Build args for bun build
  const args = ['build', srcPath, '--outfile', outPath, '--format', format, '--target', target]

  // Add external dependencies
  for (const ext of external) {
    args.push('--external', ext)
  }

  const proc = Bun.spawn(['bun', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()

  if (exitCode !== 0) {
    throw new PiBundleError(srcPath, stderr)
  }
}

/**
 * Discover extensions in a snapshot directory.
 *
 * @param snapshotPath - Path to the space snapshot
 * @returns Array of extension file paths
 */
export async function discoverExtensions(snapshotPath: string): Promise<string[]> {
  const extensionsDir = join(snapshotPath, 'extensions')
  const extensions: string[] = []

  try {
    const stats = await stat(extensionsDir)
    if (!stats.isDirectory()) {
      return extensions
    }

    const entries = await readdir(extensionsDir)
    for (const entry of entries) {
      // Skip package.json and node_modules
      if (entry === 'package.json' || entry === 'node_modules') {
        continue
      }

      // Include .ts and .js files
      if (entry.endsWith('.ts') || entry.endsWith('.js')) {
        extensions.push(join(extensionsDir, entry))
      }
    }
  } catch {
    // Extensions directory doesn't exist
  }

  return extensions
}

// ============================================================================
// Hook Bridge Generation
// ============================================================================

/**
 * Hook definition from hooks.toml or hooks.json.
 */
export interface HookDefinition {
  /** Event name */
  event: string
  /** Path to script */
  script: string
  /** Tools to filter on (optional) */
  tools?: string[] | undefined
  /** Whether hook should block (Pi: best-effort) */
  blocking?: boolean | undefined
  /** Harness-specific hook */
  harness?: string | undefined
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}

async function resolveHookScriptPath(script: string, hooksDir: string): Promise<string> {
  const normalized = script.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '').replace(/^hooks\//, '')

  // Treat commands with whitespace as raw shell commands.
  if (/\s/.test(normalized)) {
    return script
  }

  if (isAbsolute(normalized)) {
    if (await isFile(normalized)) {
      return normalized
    }
    throw new AspError(`Hook script not found: "${script}"`, 'HOOK_SCRIPT_NOT_FOUND')
  }

  const directPath = join(hooksDir, normalized)
  if (await isFile(directPath)) {
    return directPath
  }

  if (!normalized.startsWith('scripts/')) {
    const scriptsPath = join(hooksDir, 'scripts', normalized)
    if (await isFile(scriptsPath)) {
      return scriptsPath
    }
  }

  // If it doesn't look like a path, treat as a command.
  if (!normalized.includes('/') && !normalized.includes('\\')) {
    return script
  }

  throw new AspError(
    `Hook script not found: "${script}" (tried "${directPath}")`,
    'HOOK_SCRIPT_NOT_FOUND'
  )
}

/**
 * Generate the hook bridge extension for Pi.
 *
 * The hook bridge is a generated extension that translates hooks.toml/hooks.json
 * declarations into Pi event handlers that shell out to the configured scripts.
 */
export function generateHookBridgeCode(hooks: HookDefinition[], spaceIds: string[]): string {
  // Filter hooks applicable to Pi
  const piHooks = hooks.filter((h) => !h.harness || h.harness === 'pi')

  const hookRegistrations = piHooks
    .map((hook) => {
      // Map both abstract event names and Claude event names to Pi events
      const eventMap: Record<string, string> = {
        // Abstract event names (from hooks.toml)
        pre_tool_use: 'tool_call',
        post_tool_use: 'tool_result',
        session_start: 'session_start',
        session_end: 'session_shutdown',
        // Claude event names (from hooks.json)
        PreToolUse: 'tool_call',
        PostToolUse: 'tool_result',
        SessionStart: 'session_start',
        Stop: 'session_shutdown',
        // Lowercased variants (from buggy snake_case conversion in readHooksWithPrecedence)
        sessionstart: 'session_start',
        pretooluse: 'tool_call',
        posttooluse: 'tool_result',
        stop: 'session_shutdown',
      }

      const piEvent = eventMap[hook.event] || hook.event
      const toolsFilter = hook.tools ? JSON.stringify(hook.tools) : 'null'

      return `
  // Hook: ${hook.event} -> ${hook.script}
  pi.on('${piEvent}', async (event, ctx) => {
    const toolsFilter = ${toolsFilter};
    // For tool events, filter by tool name
    if (toolsFilter && event.toolName && !toolsFilter.includes(event.toolName)) {
      return;
    }

    const env = {
      ...process.env,
      ASP_TOOL_NAME: event.toolName || '',
      ASP_TOOL_ARGS: JSON.stringify(event.input || {}),
      ASP_TOOL_RESULT: JSON.stringify(event.result || {}),
      ASP_HARNESS: 'pi',
      ASP_SPACES: ${JSON.stringify(spaceIds.join(','))},
    };

    try {
      log('DEBUG', \`Running hook: ${hook.script}\`);
      const { spawn } = await import('node:child_process');
      let payload = '';
      try {
        payload = JSON.stringify(event ?? {});
      } catch {
        payload = '';
      }
      const proc = spawn('${hook.script}', [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      if (proc.stdin) {
        proc.stdin.write(payload);
        proc.stdin.end();
      }
      const exitCode = await new Promise((resolve) => proc.on('close', resolve));
      const outputParts = [];
      if (stdout.trim().length > 0) {
        outputParts.push(stdout.trimEnd());
      }
      if (stderr.trim().length > 0) {
        outputParts.push(\`[stderr]\\n\${stderr.trimEnd()}\`);
      }
      if (outputParts.length > 0 || exitCode !== 0) {
        const header = \`Hook ${hook.event}: ${hook.script}\`;
        const body = outputParts.length > 0 ? outputParts.join('\\n\\n') : '(no output)';
        const content = \`\${header}\\n\\n\${body}\`;
        const options = ctx.isIdle() ? {} : { deliverAs: 'nextTurn' };
        pi.sendMessage(
          {
            customType: 'asp-hook',
            content,
            display: true,
            details: {
              event: '${hook.event}',
              script: '${hook.script}',
              exitCode,
            },
          },
          options
        );
      }
      if (exitCode !== 0) {
        log('WARN', \`Hook script "${hook.script}" exited with \${exitCode}\`);
      } else {
        log('DEBUG', \`Hook script "${hook.script}" completed successfully\`);
      }
    } catch (err) {
      log('ERROR', \`Hook script "${hook.script}" failed: \${err}\`);
    }
  });`
    })
    .join('\n')

  return `/**
 * ASP Hook Bridge Extension
 *
 * Generated by Agent Spaces - DO NOT EDIT
 *
 * This extension bridges hooks.toml declarations to Pi event handlers,
 * executing shell scripts with standardized ASP_* environment variables.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_DIR = path.join(os.homedir(), 'praesidium', 'var', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'asp-hooks.log');

function log(level, message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, \`[\${timestamp}] [\${level}] \${message}\\n\`);
  } catch (e) {
    // Silently fail if logging fails
  }
}

module.exports = function(pi) {
  log('INFO', 'ASP Hook Bridge loaded');
${hookRegistrations || '  // No hooks configured'}
};
`
}

// ============================================================================
// PiAdapter Implementation
// ============================================================================

/**
 * PiAdapter implements the HarnessAdapter interface for Pi Coding Agent.
 *
 * This adapter handles:
 * - Detection: finds Pi binary at ~/tools/pi-mono or PATH
 * - Validation: checks space has valid extensions
 * - Materialization: bundles TypeScript extensions to JS
 * - Composition: merges extensions, skills, generates hook bridge
 * - Invocation: builds Pi CLI arguments
 */
export class PiAdapter implements HarnessAdapter {
  readonly id = 'pi' as const
  readonly name = 'Pi Coding Agent'

  readonly models: HarnessModelInfo[] = [
    {
      id: 'gpt-5.3-codex',
      name: 'GPT-5.3 Codex',
      default: true,
      description: 'openai-codex provider',
    },
    { id: 'gpt-5.3', name: 'GPT-5.3', description: 'openai-codex provider' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', description: 'openai-codex provider' },
    { id: 'gpt-5.2', name: 'GPT-5.2', description: 'openai-codex provider' },
    { id: 'gpt-5.1', name: 'GPT-5.1', description: 'openai-codex provider' },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', description: 'openai-codex provider' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', description: 'openai-codex provider' },
  ]

  /**
   * Detect if Pi is available on the system.
   */
  async detect(): Promise<HarnessDetection> {
    try {
      const info = await detectPi()
      return {
        available: true,
        version: info.version,
        path: info.path,
        capabilities: [
          ...(info.supportsExtensions ? ['extensions'] : []),
          ...(info.supportsSkills ? ['skills'] : []),
          'toolNamespacing',
        ],
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Validate that a space is compatible with Pi.
   *
   * Pi spaces should have extensions/ directory.
   * Skills are optional (Agent Skills standard).
   */
  validateSpace(_input: MaterializeSpaceInput): HarnessValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    // Pi doesn't require a specific naming pattern for extensions
    // but we can warn about potential issues

    // Check for MCP-only spaces (no extensions)
    // This is handled at composition time, not validation

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Materialize a single space into a Pi artifact directory.
   *
   * This bundles TypeScript extensions and copies skills/hooks.
   */
  async materializeSpace(
    input: MaterializeSpaceInput,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    const warnings: string[] = []
    const files: string[] = []

    try {
      // Clean any partial previous attempt
      if (options.force) {
        await rm(cacheDir, { recursive: true, force: true })
      }
      await mkdir(cacheDir, { recursive: true })

      // Get build options from manifest (pi config is optional extension)
      // Cast manifest to access potential pi config from extended schema
      const manifestWithPi = input.manifest as typeof input.manifest & {
        pi?: {
          build?: {
            format?: 'esm' | 'cjs' | undefined
            target?: 'bun' | 'node' | undefined
            external?: string[] | undefined
          }
        }
      }
      const buildOpts: ExtensionBuildOptions = {
        format: manifestWithPi.pi?.build?.format,
        target: manifestWithPi.pi?.build?.target,
        external: manifestWithPi.pi?.build?.external,
      }

      // Bundle extensions
      const extensionsDir = join(cacheDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const sourceExtensions = await discoverExtensions(input.snapshotPath)
      const spaceId = input.manifest.id

      for (const srcPath of sourceExtensions) {
        const srcBasename = basename(srcPath)
        const srcName = srcBasename.replace(/\.(ts|js)$/, '')
        // Namespace extension: spaceId__name.js
        const outName = `${spaceId}__${srcName}.js`
        const outPath = join(extensionsDir, outName)

        try {
          await bundleExtension(srcPath, outPath, buildOpts)
          files.push(`extensions/${outName}`)
        } catch (err) {
          if (err instanceof PiBundleError) {
            warnings.push(`Failed to bundle ${srcBasename}: ${err.stderr}`)
          } else {
            throw err
          }
        }
      }

      // Copy skills directory (Agent Skills standard - same as Claude)
      const srcSkillsDir = join(input.snapshotPath, 'skills')
      const destSkillsDir = join(cacheDir, 'skills')
      try {
        const skillsStats = await stat(srcSkillsDir)
        if (skillsStats.isDirectory()) {
          await copyDir(srcSkillsDir, destSkillsDir)
          const skillEntries = await readdir(destSkillsDir)
          for (const entry of skillEntries) {
            files.push(`skills/${entry}`)
          }
        }
      } catch {
        // Skills directory doesn't exist
      }

      // Copy hooks directory as hooks-scripts/ (Pi has incompatible hooks/ format)
      const srcHooksDir = join(input.snapshotPath, 'hooks')
      const destHooksDir = join(cacheDir, 'hooks-scripts')
      try {
        const hooksStats = await stat(srcHooksDir)
        if (hooksStats.isDirectory()) {
          await copyDir(srcHooksDir, destHooksDir)
          const hookEntries = await readdir(destHooksDir)
          for (const entry of hookEntries) {
            files.push(`hooks-scripts/${entry}`)
          }
        }
      } catch {
        // Hooks directory doesn't exist
      }

      // Copy shared directory
      const srcSharedDir = join(input.snapshotPath, 'shared')
      try {
        const sharedStats = await stat(srcSharedDir)
        if (sharedStats.isDirectory()) {
          await copyDir(srcSharedDir, cacheDir)
        }
      } catch {
        // Shared directory doesn't exist
      }

      // Copy scripts directory
      const srcScriptsDir = join(input.snapshotPath, 'scripts')
      const destScriptsDir = join(cacheDir, 'scripts')
      try {
        const scriptsStats = await stat(srcScriptsDir)
        if (scriptsStats.isDirectory()) {
          await copyDir(srcScriptsDir, destScriptsDir)
        }
      } catch {
        // Scripts directory doesn't exist
      }

      // Link instructions file (AGENT.md → AGENT.md for Pi)
      const instructionsResult = await linkInstructionsFile(input.snapshotPath, cacheDir, 'pi')
      if (instructionsResult.linked && instructionsResult.destFile) {
        files.push(instructionsResult.destFile)
      }

      // Copy permissions.toml if present (for composition to read later)
      if (await permissionsTomlExists(input.snapshotPath)) {
        const srcPerms = join(input.snapshotPath, PERMISSIONS_TOML_FILENAME)
        const destPerms = join(cacheDir, PERMISSIONS_TOML_FILENAME)
        await linkOrCopy(srcPerms, destPerms)
        files.push(PERMISSIONS_TOML_FILENAME)
      }

      return {
        artifactPath: cacheDir,
        files,
        warnings,
      }
    } catch (err) {
      // Clean up on failure
      await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  /**
   * Compose a target bundle from ordered space artifacts.
   *
   * This assembles materialized artifacts into the final target structure:
   * - asp_modules/<target>/pi/extensions/
   * - asp_modules/<target>/pi/skills/
   * - asp_modules/<target>/pi/asp-hooks.bridge.js
   */
  async composeTarget(
    input: ComposeTargetInput,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult> {
    const warnings: LockWarning[] = []

    // Clean output if requested
    if (options.clean) {
      await rm(outputDir, { recursive: true, force: true })
    }
    await mkdir(outputDir, { recursive: true })

    // Merge extensions from all spaces
    const extensionsDir = join(outputDir, 'extensions')
    await mkdir(extensionsDir, { recursive: true })

    // Track extension files for W303 collision detection
    const extensionSources = new Map<string, string>() // filename -> spaceId

    for (const artifact of input.artifacts) {
      const srcExtDir = join(artifact.artifactPath, 'extensions')
      try {
        const stats = await stat(srcExtDir)
        if (stats.isDirectory()) {
          const entries = await readdir(srcExtDir)
          for (const file of entries) {
            // Files are already namespaced: spaceId__name.js
            const srcPath = join(srcExtDir, file)
            const destPath = join(extensionsDir, file)

            // Check for W303: tool collision after namespacing
            const existingSource = extensionSources.get(file)
            if (existingSource && existingSource !== artifact.spaceId) {
              warnings.push({
                code: WARNING_CODES.PI_TOOL_COLLISION,
                message: `Extension file collision: "${file}" from "${artifact.spaceId}" overwrites file from "${existingSource}"`,
              })
            }
            extensionSources.set(file, artifact.spaceId)

            await linkOrCopy(srcPath, destPath)
          }
        }
      } catch {
        // Extensions directory doesn't exist in this artifact
      }
    }

    // Merge skills directories
    const skillsDir = join(outputDir, 'skills')
    await mkdir(skillsDir, { recursive: true })

    for (const artifact of input.artifacts) {
      const srcSkillsDir = join(artifact.artifactPath, 'skills')
      try {
        const stats = await stat(srcSkillsDir)
        if (stats.isDirectory()) {
          // Copy each skill subdirectory
          const skillEntries = await readdir(srcSkillsDir, { withFileTypes: true })
          for (const entry of skillEntries) {
            if (entry.isDirectory()) {
              const srcPath = join(srcSkillsDir, entry.name)
              const destPath = join(skillsDir, entry.name)
              await copyDir(srcPath, destPath)
            }
          }
        }
      } catch {
        // Skills directory doesn't exist in this artifact
      }
    }

    // Merge hooks directories and collect hook definitions
    // Priority: hooks.toml (canonical harness-agnostic) > hooks.json (legacy)
    // Use hooks-scripts/ to avoid conflict with Pi's incompatible hooks/ format
    const hooksDir = join(outputDir, 'hooks-scripts')
    await mkdir(hooksDir, { recursive: true })
    const allHooks: HookDefinition[] = []

    for (const artifact of input.artifacts) {
      const srcHooksDir = join(artifact.artifactPath, 'hooks-scripts')
      try {
        const stats = await stat(srcHooksDir)
        if (stats.isDirectory()) {
          await copyDir(srcHooksDir, hooksDir)

          // Read hooks with hooks.toml taking precedence over hooks.json
          const hooksResult = await readHooksWithPrecedence(srcHooksDir)
          if (hooksResult.hooks.length > 0) {
            // Adjust script paths to be relative to composed hooks dir
            for (const hook of hooksResult.hooks) {
              // Extract script path - handle both raw scripts and ${CLAUDE_PLUGIN_ROOT} paths
              // 1. Strip ${CLAUDE_PLUGIN_ROOT}/ prefix
              // 2. Strip hooks/ prefix since we renamed hooks/ to hooks-scripts/
              const scriptPath = await resolveHookScriptPath(hook.script, hooksDir)

              allHooks.push({
                event: hook.event,
                script: scriptPath,
                tools: hook.tools,
                blocking: hook.blocking,
                harness: hook.harness,
              })
            }
          }
        }
      } catch {
        // Hooks directory doesn't exist in this artifact
      }
    }

    // Generate hook bridge extension
    let hookBridgePath: string | undefined
    const spaceIds = input.artifacts.map((a) => a.spaceId)

    if (allHooks.length > 0) {
      hookBridgePath = join(outputDir, 'asp-hooks.bridge.js')
      const hookBridgeCode = generateHookBridgeCode(allHooks, spaceIds)
      await writeFile(hookBridgePath, hookBridgeCode)

      // Check for W301: blocking hooks that Pi can't enforce
      for (const hook of allHooks) {
        if (hook.blocking && !PI_BLOCKING_EVENTS.includes(hook.event)) {
          warnings.push({
            code: WARNING_CODES.PI_HOOK_CANNOT_BLOCK,
            message: `Hook '${hook.event}' marked blocking=true but Pi cannot block this event`,
          })
        }
      }
    }

    // Check skills directory has content
    let skillsDirPath: string | undefined
    try {
      const skillsEntries = await readdir(skillsDir)
      if (skillsEntries.length > 0) {
        skillsDirPath = skillsDir
      }
    } catch {
      // No skills
    }

    // Create symlink to ~/.pi/agent/auth.json for Pi authentication
    const piAuthSource = join(homedir(), '.pi', 'agent', 'auth.json')
    const piAuthDest = join(outputDir, 'auth.json')
    try {
      const authStats = await stat(piAuthSource)
      if (authStats.isFile()) {
        // Remove existing symlink/file if present
        await rm(piAuthDest, { force: true })
        await symlink(piAuthSource, piAuthDest)
      }
    } catch {
      // ~/.pi/auth.json doesn't exist - Pi will prompt for auth
    }

    // Generate settings.json to control skill discovery
    // By default, disable .claude/.codex directories but allow Pi directories
    // The --inherit-project and --inherit-user flags can enable Pi directories
    const piSettings = {
      skills: {
        enableCodexUser: false,
        enableClaudeUser: false,
        enableClaudeProject: false,
        enablePiUser: options.inheritUser ?? false,
        enablePiProject: options.inheritProject ?? false,
      },
    }
    const settingsPath = join(outputDir, 'settings.json')
    await writeFile(settingsPath, JSON.stringify(piSettings, null, 2))

    // Read permissions.toml from each artifact and generate warnings for lint_only facets
    for (const artifact of input.artifacts) {
      const permissions = await readPermissionsToml(artifact.artifactPath)
      if (permissions && hasPermissions(permissions)) {
        const piPerms = toPiPermissions(permissions)

        // Generate W304 warning for each lint_only permission facet
        const lintOnlyFacets = this.collectLintOnlyFacets(piPerms)

        if (lintOnlyFacets.length > 0) {
          warnings.push({
            code: WARNING_CODES.PI_PERMISSION_LINT_ONLY,
            message: `Space "${artifact.spaceId}" has permissions.toml with facets that Pi cannot enforce (lint-only): ${lintOnlyFacets.join(', ')}`,
          })
        }
      }
    }

    const bundle: ComposedTargetBundle = {
      harnessId: 'pi',
      targetName: input.targetName,
      rootDir: outputDir,
      pi: {
        extensionsDir,
        skillsDir: skillsDirPath,
        hookBridgePath,
      },
    }

    return { bundle, warnings }
  }

  private collectLintOnlyFacets(piPerms: ReturnType<typeof toPiPermissions>): string[] {
    const lintOnlyFacets: string[] = []

    if (piPerms.read?.enforcement === 'lint_only' && piPerms.read.value?.length) {
      lintOnlyFacets.push('read')
    }
    if (piPerms.write?.enforcement === 'lint_only' && piPerms.write.value?.length) {
      lintOnlyFacets.push('write')
    }
    if (piPerms.network?.enforcement === 'lint_only' && piPerms.network.value?.length) {
      lintOnlyFacets.push('network')
    }
    if (piPerms.deny?.read?.enforcement === 'lint_only' && piPerms.deny.read.value?.length) {
      lintOnlyFacets.push('deny.read')
    }
    if (piPerms.deny?.write?.enforcement === 'lint_only' && piPerms.deny.write.value?.length) {
      lintOnlyFacets.push('deny.write')
    }
    if (piPerms.deny?.exec?.enforcement === 'lint_only' && piPerms.deny.exec.value?.length) {
      lintOnlyFacets.push('deny.exec')
    }
    if (piPerms.deny?.network?.enforcement === 'lint_only' && piPerms.deny.network.value?.length) {
      lintOnlyFacets.push('deny.network')
    }

    return lintOnlyFacets
  }

  /**
   * Build CLI arguments for running Pi with a composed target bundle.
   *
   * This is a synchronous method (required by interface), so we use sync fs operations.
   */
  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
    const args: string[] = []

    if (!bundle.pi) {
      throw new AspError('Pi bundle is missing - cannot build run args', 'PI_BUNDLE_MISSING')
    }

    // Add extensions from the extensions directory
    const extensionsDir = bundle.pi.extensionsDir
    let hasExtensions = false

    // Use readdirSync to list extension files (sync required by interface)
    const entries = readdirSync(extensionsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        args.push('--extension', join(extensionsDir, entry.name))
        hasExtensions = true
      }
    }

    // Add hook bridge extension
    if (bundle.pi.hookBridgePath) {
      args.push('--extension', bundle.pi.hookBridgePath)
      hasExtensions = true
    }

    // If no extensions found, add --no-extensions flag
    if (!hasExtensions) {
      args.push('--no-extensions')
    }

    // Disable default skill loading from local/user directories.
    args.push('--no-skills')

    // Model translation (sonnet -> claude-sonnet, etc.)
    // Default to gpt-5.3-codex with openai-codex provider if no model specified
    const model = options.model || 'gpt-5.3-codex'
    const translatedModel = MODEL_TRANSLATION[model] || model
    args.push('--model', translatedModel)

    // Default provider for Pi
    args.push('--provider', 'openai-codex')

    // Add --print for non-interactive mode
    if (options.interactive === false) {
      args.push('--print')
    }

    // Handle resume option: --resume or -r (Pi opens picker, no session ID arg)
    if (options.resume) {
      args.push('--resume')
      // Pi's --resume flag doesn't take a session ID argument;
      // it always opens the session picker
    }

    // Add extra args
    if (options.extraArgs) {
      args.push(...options.extraArgs)
    }

    // Add prompt as positional argument (Pi takes prompt after flags)
    if (options.prompt) {
      args.push(options.prompt)
    }

    // Note: Pi uses cwd for project path, not a positional argument

    return args
  }

  /**
   * Get the output directory path for a Pi target bundle.
   *
   * Returns: asp_modules/<targetName>/pi
   */
  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, 'pi')
  }

  async loadTargetBundle(outputDir: string, targetName: string): Promise<ComposedTargetBundle> {
    const extensionsDir = join(outputDir, 'extensions')
    const skillsDir = join(outputDir, 'skills')
    const hookBridgePath = join(outputDir, 'asp-hooks.bridge.js')

    let skillsDirPath: string | undefined
    try {
      const entries = await readdir(skillsDir)
      if (entries.length > 0) {
        skillsDirPath = skillsDir
      }
    } catch {
      // No skills directory
    }

    let hookBridge: string | undefined
    try {
      const stats = await stat(hookBridgePath)
      if (stats.isFile()) {
        hookBridge = hookBridgePath
      }
    } catch {
      // No hook bridge
    }

    return {
      harnessId: 'pi',
      targetName,
      rootDir: outputDir,
      pi: {
        extensionsDir,
        skillsDir: skillsDirPath,
        hookBridgePath: hookBridge,
      },
    }
  }

  getRunEnv(bundle: ComposedTargetBundle, _options: HarnessRunOptions): Record<string, string> {
    return { PI_CODING_AGENT_DIR: bundle.rootDir }
  }

  getDefaultRunOptions(
    _manifest: ProjectManifest,
    _targetName: string
  ): Partial<HarnessRunOptions> {
    return {}
  }
}

/**
 * Singleton instance of PiAdapter
 */
export const piAdapter = new PiAdapter()
