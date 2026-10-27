/**
 * Test setup utilities for integration tests.
 *
 * WHY: We need to set up a real git repository with tags for the
 * integration tests to work. This module handles initialization
 * of the sample-registry fixture as a proper git repo with tags.
 */

import { exec } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { hermeticAgentsRoot, seedImmutableRegistryMirror } from './hermetic.js'

const execAsync = promisify(exec)

/** Path to the fixtures directory */
export const FIXTURES_DIR = path.join(import.meta.dir, '..', 'fixtures')

/**
 * Per-process scratch root for the suite's shared mutable state: the git-backed
 * copy of the sample-registry fixture and the claude shim's output file.
 *
 * WHY: the registry used to be git-initialised in place, which wrote
 * `fixtures/sample-registry/.git` into the checkout and raced between two
 * concurrent runs on the same tree; the shim output sat at a fixed
 * `/tmp/claude-shim-output.json` shared by every run on the host. Both now live
 * under one mkdtemp root this process owns and removes on exit.
 */
const TEST_SCRATCH_ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'asp-integration-')))
process.on('exit', () => {
  rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true })
})

/** Path to the committed sample-registry fixture (read-only source of the copy). */
const SAMPLE_REGISTRY_FIXTURE_DIR = path.join(FIXTURES_DIR, 'sample-registry')

/** Path to this process's git-backed copy of the sample-registry fixture. */
export const SAMPLE_REGISTRY_DIR = path.join(TEST_SCRATCH_ROOT, 'sample-registry')

/** Path to the sample-project fixture */
export const SAMPLE_PROJECT_DIR = path.join(FIXTURES_DIR, 'sample-project')

/** Path to the claude shim */
export const CLAUDE_SHIM_PATH = path.join(FIXTURES_DIR, 'claude-shim', 'claude')

/** Path to the codex shim */
export const CODEX_SHIM_PATH = path.join(FIXTURES_DIR, 'codex-shim', 'codex')

/** Path to the claude shim output file */
export const SHIM_OUTPUT_FILE = path.join(TEST_SCRATCH_ROOT, 'claude-shim-output.json')

let sampleRegistryReady: Promise<void> | undefined

/**
 * Initialize this process's copy of the sample-registry as a git repository
 * with proper tags.
 *
 * WHY: The resolver needs git tags to resolve space references. The fixture is
 * copied fresh from the committed tree once per process (so it always reflects
 * the files on disk) and git-initialised in the copy, never in the checkout.
 */
export function initSampleRegistry(): Promise<void> {
  sampleRegistryReady ??= buildSampleRegistry().catch((error: unknown) => {
    sampleRegistryReady = undefined
    throw error
  })
  return sampleRegistryReady
}

async function buildSampleRegistry(): Promise<void> {
  const registryDir = SAMPLE_REGISTRY_DIR
  await fs.rm(registryDir, { recursive: true, force: true })
  // Skip any `.git` a pre-fix run left inside the committed fixture.
  const fixtureGitDir = path.join(SAMPLE_REGISTRY_FIXTURE_DIR, '.git')
  await fs.cp(SAMPLE_REGISTRY_FIXTURE_DIR, registryDir, {
    recursive: true,
    filter: (source) =>
      source !== fixtureGitDir && !source.startsWith(`${fixtureGitDir}${path.sep}`),
  })

  // Initialize git repo
  await execAsync('git init', { cwd: registryDir })

  // Configure git for tests
  await execAsync('git config user.email "test@example.com"', { cwd: registryDir })
  await execAsync('git config user.name "Test User"', { cwd: registryDir })

  // Add all files
  await execAsync('git add -A', { cwd: registryDir })

  // Initial commit
  await execAsync('git commit -m "Initial commit with base, frontend, backend spaces"', {
    cwd: registryDir,
  })

  // Create tags for spaces
  // Base space v1.0.0, v1.0.1, v1.1.0, v2.0.0 (for semver range testing)
  await execAsync('git tag space/base/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/base/v1.0.1', { cwd: registryDir })
  await execAsync('git tag space/base/v1.1.0', { cwd: registryDir })
  await execAsync('git tag space/base/v2.0.0', { cwd: registryDir })
  await execAsync('git tag space/base/stable', { cwd: registryDir })

  // Frontend space v1.0.0 and v1.1.0
  await execAsync('git tag space/frontend/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/frontend/stable', { cwd: registryDir })

  // For v1.1.0, we need another commit with a version update
  const frontendTomlPath = path.join(registryDir, 'spaces', 'frontend', 'space.toml')
  const _frontendToml = await fs.readFile(frontendTomlPath, 'utf-8')
  // Already at 1.1.0, just tag it
  await execAsync('git tag space/frontend/v1.1.0', { cwd: registryDir })
  await execAsync('git tag space/frontend/latest', { cwd: registryDir })

  // Backend space v1.0.0
  await execAsync('git tag space/backend/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/backend/stable', { cwd: registryDir })

  // Test spaces for lint warnings W203-W207
  await execAsync('git tag space/hooks-bad-path/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/hooks-bad-path/stable', { cwd: registryDir })

  await execAsync('git tag space/hooks-invalid/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/hooks-invalid/stable', { cwd: registryDir })

  await execAsync('git tag space/same-plugin-a/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/same-plugin-a/stable', { cwd: registryDir })

  await execAsync('git tag space/same-plugin-b/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/same-plugin-b/stable', { cwd: registryDir })

  await execAsync('git tag space/hooks-non-exec/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/hooks-non-exec/stable', { cwd: registryDir })

  await execAsync('git tag space/bad-structure/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/bad-structure/stable', { cwd: registryDir })

  // MCP test spaces
  await execAsync('git tag space/mcp-server-a/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/mcp-server-a/stable', { cwd: registryDir })

  await execAsync('git tag space/mcp-server-b/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/mcp-server-b/stable', { cwd: registryDir })

  await execAsync('git tag space/mcp-collision-a/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/mcp-collision-a/stable', { cwd: registryDir })

  await execAsync('git tag space/mcp-collision-b/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/mcp-collision-b/stable', { cwd: registryDir })

  // Command-collision pair for W201. Kept off frontend/backend so the fixture's
  // ordinary composable spaces stay materializable together.
  await execAsync('git tag space/cmd-collision-a/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/cmd-collision-a/stable', { cwd: registryDir })

  await execAsync('git tag space/cmd-collision-b/v1.0.0', { cwd: registryDir })
  await execAsync('git tag space/cmd-collision-b/stable', { cwd: registryDir })
}

/**
 * Discard this process's sample-registry copy so the next
 * {@link initSampleRegistry} rebuilds it from the committed fixture.
 */
export async function cleanupSampleRegistry(): Promise<void> {
  sampleRegistryReady = undefined
  await fs.rm(SAMPLE_REGISTRY_DIR, { recursive: true, force: true })
}

/**
 * Create a temporary ASP_HOME directory for tests.
 */
export async function createTempAspHome(): Promise<string> {
  const tmpDir = await fs.mkdtemp('/tmp/asp-test-')
  await fs.mkdir(path.join(tmpDir, 'snapshots'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'cache'), { recursive: true })
  // Without the mirror in place the first target resolution clones the canonical
  // spaces-repo, which the test Git guard forbids. See ./hermetic.ts.
  seedImmutableRegistryMirror(tmpDir)
  return tmpDir
}

/**
 * Clean up a temporary ASP_HOME directory.
 */
export async function cleanupTempAspHome(aspHome: string): Promise<void> {
  await fs.rm(aspHome, { recursive: true, force: true })
}

/**
 * Read the claude shim output file.
 */
export async function readShimOutput(): Promise<{
  timestamp: string
  args: string[]
  pluginDirs: string[]
  mcpConfig: string | null
  workingDir: string
}> {
  const content = await fs.readFile(SHIM_OUTPUT_FILE, 'utf-8')
  return JSON.parse(content)
}

/**
 * Clean up the claude shim output file.
 */
export async function cleanupShimOutput(): Promise<void> {
  try {
    await fs.unlink(SHIM_OUTPUT_FILE)
  } catch {
    // Ignore if doesn't exist
  }
}

/**
 * Create a temporary project directory.
 */
export async function createTempProject(
  targets: Record<
    string,
    {
      description?: string | undefined
      priming_prompt?: string | undefined
      compose: string[]
    }
  >
): Promise<string> {
  const tmpDir = await fs.mkdtemp('/tmp/asp-project-')

  // Write asp-targets.toml
  let toml = 'schema = 2\n\n'
  for (const [name, target] of Object.entries(targets)) {
    toml += `[targets.${name}]\n`
    if (target.description) {
      toml += `description = "${target.description}"\n`
    }
    if (target.priming_prompt) {
      toml += `priming = "${target.priming_prompt}"\n`
    }
    toml += 'compose = [\n'
    for (const ref of target.compose) {
      toml += `  "${ref}",\n`
    }
    toml += ']\n\n'
  }

  await fs.writeFile(path.join(tmpDir, 'asp-targets.toml'), toml)

  return tmpDir
}

/**
 * Clean up a temporary project directory.
 */
export async function cleanupTempProject(projectDir: string): Promise<void> {
  await fs.rm(projectDir, { recursive: true, force: true })
}

/**
 * `process.env` with the undefined-valued keys dropped.
 *
 * `ProcessEnv` values are `string | undefined`, which cannot seed a
 * `Record<string, string>` under the repo's `exactOptionalPropertyTypes`.
 */
function definedProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

/**
 * Set environment variables for testing with the claude shim.
 */
export function getTestEnv(aspHome: string): Record<string, string> {
  return {
    ...definedProcessEnv(),
    ASP_HOME: aspHome,
    ASP_AGENTS_ROOT: hermeticAgentsRoot(),
    ASP_CLAUDE_PATH: CLAUDE_SHIM_PATH,
    CLAUDE_SHIM_OUTPUT: SHIM_OUTPUT_FILE,
    CLAUDE_SHIM_VALIDATE_PLUGINS: '1',
  }
}

/**
 * Set environment variables for testing with the codex shim.
 */
export function getCodexTestEnv(aspHome: string): Record<string, string> {
  const shimDir = path.dirname(CODEX_SHIM_PATH)
  const pathEnv = [shimDir, process.env['PATH'] ?? ''].filter(Boolean).join(path.delimiter)
  return {
    ...definedProcessEnv(),
    ASP_HOME: aspHome,
    ASP_AGENTS_ROOT: hermeticAgentsRoot(),
    PATH: pathEnv,
  }
}

export function extractDryRunCommand(stdout: string): string {
  const commandLabelIndex = stdout.indexOf('Command:')
  if (commandLabelIndex >= 0) {
    return stdout.slice(commandLabelIndex + 'Command:'.length).trim()
  }

  const commandBlockIndex = stdout.indexOf('── command ──')
  if (commandBlockIndex >= 0) {
    return stdout.slice(commandBlockIndex + '── command ──'.length).trim()
  }

  return ''
}
