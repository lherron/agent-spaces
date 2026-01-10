/**
 * Test setup utilities for integration tests.
 *
 * WHY: We need to set up a real git repository with tags for the
 * integration tests to work. This module handles initialization
 * of the sample-registry fixture as a proper git repo with tags.
 */

import { exec } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

/** Path to the fixtures directory */
export const FIXTURES_DIR = path.join(import.meta.dir, '..', 'fixtures')

/** Path to the sample-registry fixture */
export const SAMPLE_REGISTRY_DIR = path.join(FIXTURES_DIR, 'sample-registry')

/** Path to the sample-project fixture */
export const SAMPLE_PROJECT_DIR = path.join(FIXTURES_DIR, 'sample-project')

/** Path to the claude shim */
export const CLAUDE_SHIM_PATH = path.join(FIXTURES_DIR, 'claude-shim', 'claude')

/** Path to the claude shim output file */
export const SHIM_OUTPUT_FILE = '/tmp/claude-shim-output.json'

/**
 * Initialize the sample-registry as a git repository with proper tags.
 *
 * WHY: The resolver needs git tags to resolve space references.
 * This function creates the git repo structure and tags.
 */
export async function initSampleRegistry(): Promise<void> {
  const registryDir = SAMPLE_REGISTRY_DIR

  // Check if .git already exists
  const gitDir = path.join(registryDir, '.git')
  try {
    await fs.access(gitDir)
    // Git repo already exists, just verify tags
    return
  } catch {
    // .git doesn't exist, initialize
  }

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
  // Base space v1.0.0
  await execAsync('git tag space/base/v1.0.0', { cwd: registryDir })
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
}

/**
 * Clean up the sample-registry git repository.
 */
export async function cleanupSampleRegistry(): Promise<void> {
  const gitDir = path.join(SAMPLE_REGISTRY_DIR, '.git')
  try {
    await fs.rm(gitDir, { recursive: true, force: true })
  } catch {
    // Ignore if doesn't exist
  }
}

/**
 * Create a temporary ASP_HOME directory for tests.
 */
export async function createTempAspHome(): Promise<string> {
  const tmpDir = await fs.mkdtemp('/tmp/asp-test-')
  await fs.mkdir(path.join(tmpDir, 'store', 'spaces'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'cache', 'materialized'), { recursive: true })
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
      compose: string[]
    }
  >
): Promise<string> {
  const tmpDir = await fs.mkdtemp('/tmp/asp-project-')

  // Write asp-targets.toml
  let toml = 'schema = 1\n\n'
  for (const [name, target] of Object.entries(targets)) {
    toml += `[targets.${name}]\n`
    if (target.description) {
      toml += `description = "${target.description}"\n`
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
 * Set environment variables for testing with the claude shim.
 */
export function getTestEnv(aspHome: string): Record<string, string> {
  return {
    ...process.env,
    ASP_HOME: aspHome,
    ASP_CLAUDE_PATH: CLAUDE_SHIM_PATH,
    CLAUDE_SHIM_OUTPUT: SHIM_OUTPUT_FILE,
    CLAUDE_SHIM_VALIDATE_PLUGINS: '1',
  }
}
