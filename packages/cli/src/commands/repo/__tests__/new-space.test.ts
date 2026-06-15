/**
 * RED tests for T-04410: asp repo new-space <spaceId>
 *
 * WHY: These tests define the contract for the new `asp repo new-space` command
 * (daedalus ruling C-04456). All 6 tests FAIL now (command absent) and must
 * PASS once implementation lands. Do NOT implement — tests only.
 *
 * Command contract (daedalus ruling C-04456):
 * - `asp repo new-space <spaceId>` with --description, --version, --asp-home
 * - Requires initialized registry (asp repo init first)
 * - Rejects existing spaces/<spaceId>/space.toml
 * - Writes spaces/<spaceId>/space.toml + dirs: commands/ skills/ agents/ hooks/scripts/ mcp/
 * - NO commands/example.md (new-space only; example stays behind spaces-init compat option)
 * - After write: calls readSpaceManifestFromFilesystem + validateSpaceManifest;
 *   parse/validate failure => hard nonzero exit
 *
 * Tests map to daedalus 1-6:
 *   1. Blessed file/dir shape (all required paths, no example.md)
 *   2. Generated space.toml passes readSpaceManifestFromFilesystem + validateSpaceManifest
 *   3. Existing-space rejection (nonzero, no overwrite)
 *   4. Invalid ID rejection before writing (non-kebab / too-long)
 *   5. Validation-gate: malformed space.toml is caught by the same API the command calls
 *   6. Compatibility: asp spaces init still works alongside new command
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolver } from 'spaces-config'

// ============================================================================
// Helpers
// ============================================================================

// packages/cli/src/commands/repo/__tests__/ → 4 levels up → packages/cli/
const ASP_CLI = join(import.meta.dirname, '..', '..', '..', '..', 'bin', 'asp.js')
const CLI_TEST_TIMEOUT_MS = 60_000

type RunResult = { stdout: string; stderr: string; exitCode: number }

/**
 * Run the asp CLI with given args and return stdout/stderr/exitCode.
 */
function runAsp(args: string[], env?: Record<string, string>): RunResult {
  try {
    const stdout = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: CLI_TEST_TIMEOUT_MS,
      env: { ...process.env, ...env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    }
  }
}

/**
 * Initialize a fresh temp registry and return paths.
 * Uses asp repo init --no-manager so git setup is fast.
 */
async function setupTempRegistry(): Promise<{ aspHome: string; repoPath: string }> {
  const aspHome = await mkdtemp(join(tmpdir(), 'asp-ns-'))
  const result = runAsp(['repo', 'init', '--no-manager', '--asp-home', aspHome])
  if (result.exitCode !== 0) {
    throw new Error(`registry init failed: ${result.stderr}`)
  }
  return { aspHome, repoPath: join(aspHome, 'repo') }
}

/** Return true if the filesystem path exists. */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

// ============================================================================
// Test 1 — Blessed file/dir shape (T-04410 daedalus #1)
// ============================================================================
describe('asp repo new-space creates blessed file/dir shape (T-04410 #1)', () => {
  test(
    'creates exact space.toml + required dirs, no example.md',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      try {
        // RED: command does not exist yet — this exits 2 ("unknown command")
        const result = runAsp([
          'repo',
          'new-space',
          'sample-space',
          '--description',
          'A sample space for testing',
          '--version',
          '0.2.0',
          '--asp-home',
          aspHome,
        ])
        expect(result.exitCode).toBe(0)

        const spaceDir = join(repoPath, 'spaces', 'sample-space')

        // space.toml must exist
        expect(await exists(join(spaceDir, 'space.toml'))).toBe(true)

        // Required directories must exist
        expect(await exists(join(spaceDir, 'commands'))).toBe(true)
        expect(await exists(join(spaceDir, 'skills'))).toBe(true)
        expect(await exists(join(spaceDir, 'agents'))).toBe(true)
        expect(await exists(join(spaceDir, 'hooks', 'scripts'))).toBe(true)
        expect(await exists(join(spaceDir, 'mcp'))).toBe(true)

        // NO example.md — new-space does not emit it
        expect(await exists(join(spaceDir, 'commands', 'example.md'))).toBe(false)

        // Verify space.toml content fields
        const toml = await readFile(join(spaceDir, 'space.toml'), 'utf-8')
        expect(toml).toContain('schema = 1')
        expect(toml).toContain('id = "sample-space"')
        expect(toml).toContain('version = "0.2.0"')
        expect(toml).toContain('description = "A sample space for testing"')
        expect(toml).toContain('[plugin]')
        expect(toml).toContain('name = "sample-space"')
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    'default version is 0.1.0 when --version omitted',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      try {
        const result = runAsp(['repo', 'new-space', 'default-ver-space', '--asp-home', aspHome])
        expect(result.exitCode).toBe(0)

        const toml = await readFile(
          join(repoPath, 'spaces', 'default-ver-space', 'space.toml'),
          'utf-8'
        )
        expect(toml).toContain('version = "0.1.0"')
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    'description field omitted when --description not supplied',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      try {
        const result = runAsp(['repo', 'new-space', 'no-desc-space', '--asp-home', aspHome])
        expect(result.exitCode).toBe(0)

        const toml = await readFile(
          join(repoPath, 'spaces', 'no-desc-space', 'space.toml'),
          'utf-8'
        )
        // description must NOT appear when not supplied
        expect(toml).not.toContain('description')
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )
})

// ============================================================================
// Test 2 — Generated manifest passes library validation (T-04410 daedalus #2)
// ============================================================================
describe('generated space.toml passes readSpaceManifestFromFilesystem + validateSpaceManifest (T-04410 #2)', () => {
  test(
    'manifest parses and validates without errors',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      try {
        // RED: command absent → exits 2
        const result = runAsp([
          'repo',
          'new-space',
          'validated-space',
          '--description',
          'Validate me',
          '--asp-home',
          aspHome,
        ])
        expect(result.exitCode).toBe(0)

        // Use the library functions the command is required to call internally
        const manifest = await resolver.readSpaceManifestFromFilesystem('validated-space', {
          cwd: repoPath,
        })
        expect(manifest).toBeDefined()
        expect(manifest.id).toBe('validated-space')
        expect(manifest.version).toBe('0.1.0')

        const validation = resolver.validateSpaceManifest(manifest)
        expect(validation.valid).toBe(true)
        expect(validation.errors).toHaveLength(0)
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )
})

// ============================================================================
// Test 3 — Existing-space rejection (T-04410 daedalus #3)
// ============================================================================
describe('asp repo new-space rejects existing space (T-04410 #3)', () => {
  test(
    'second run for same id exits nonzero and does not overwrite',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      try {
        // First run: should succeed (RED now — command absent)
        const first = runAsp(['repo', 'new-space', 'dup-space', '--asp-home', aspHome])
        expect(first.exitCode).toBe(0)

        // Record the original content
        const originalToml = await readFile(
          join(repoPath, 'spaces', 'dup-space', 'space.toml'),
          'utf-8'
        )

        // Second run: must exit nonzero
        const second = runAsp(['repo', 'new-space', 'dup-space', '--asp-home', aspHome])
        expect(second.exitCode).not.toBe(0)

        // Error output should mention the conflict
        const output = second.stdout + second.stderr
        expect(output).toMatch(/already exist|conflict|duplicate|exists/i)

        // space.toml must be unchanged
        const afterToml = await readFile(
          join(repoPath, 'spaces', 'dup-space', 'space.toml'),
          'utf-8'
        )
        expect(afterToml).toBe(originalToml)
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )
})

// ============================================================================
// Test 4 — Invalid ID rejection before writing (T-04410 daedalus #4)
// ============================================================================
describe('asp repo new-space rejects invalid space IDs before writing (T-04410 #4)', () => {
  test(
    'non-kebab-case ID exits nonzero',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      try {
        // PascalCase is invalid
        const result = runAsp(['repo', 'new-space', 'NotKebabCase', '--asp-home', aspHome])
        expect(result.exitCode).not.toBe(0)

        const output = result.stdout + result.stderr
        expect(output).toMatch(/invalid|kebab|id/i)

        // No files must have been written
        expect(await exists(join(repoPath, 'spaces', 'NotKebabCase'))).toBe(false)
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    'space ID longer than 64 chars exits nonzero',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      const longId = 'a'.repeat(65)
      try {
        const result = runAsp(['repo', 'new-space', longId, '--asp-home', aspHome])
        expect(result.exitCode).not.toBe(0)

        const output = result.stdout + result.stderr
        expect(output).toMatch(/invalid|length|64|id/i)

        // No files must have been written
        expect(await exists(join(repoPath, 'spaces', longId))).toBe(false)
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    'ID starting with a digit exits nonzero',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      try {
        const result = runAsp(['repo', 'new-space', '1bad-start', '--asp-home', aspHome])
        expect(result.exitCode).not.toBe(0)

        // Error must describe the ID constraint (not just "unknown command")
        // RED: when command absent, output = "unknown command 'new-space'" which won't match
        const output = result.stdout + result.stderr
        expect(output).toMatch(/invalid|kebab|letter|id/i)

        expect(await exists(join(repoPath, 'spaces', '1bad-start'))).toBe(false)
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )
})

// ============================================================================
// Test 5 — Validation gate: malformed manifest is a hard failure (T-04410 daedalus #5)
// ============================================================================
describe('validation gate: malformed space.toml is caught by readSpaceManifestFromFilesystem (T-04410 #5)', () => {
  test(
    'generated manifest passes; injected malformed manifest rejected by same validator',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      try {
        // RED: command absent → exits 2; GREEN once command exists
        const result = runAsp(['repo', 'new-space', 'validate-gate-space', '--asp-home', aspHome])
        expect(result.exitCode).toBe(0)

        // Verify the generated manifest is valid (warm path — command succeeded)
        const goodManifest = await resolver.readSpaceManifestFromFilesystem('validate-gate-space', {
          cwd: repoPath,
        })
        const goodResult = resolver.validateSpaceManifest(goodManifest)
        expect(goodResult.valid).toBe(true)

        // Now overwrite with a MALFORMED space.toml (missing required `id` field)
        // This simulates what a buggy scaffold writer would produce.
        // The same API the command calls must reject it.
        const malformedToml = [
          'schema = 1',
          '# id field intentionally omitted — simulates buggy generator output',
          'version = "0.1.0"',
          '',
          '[plugin]',
          'name = "validate-gate-space"',
          '',
        ].join('\n')

        await writeFile(
          join(repoPath, 'spaces', 'validate-gate-space', 'space.toml'),
          malformedToml
        )

        // readSpaceManifestFromFilesystem + validateSpaceManifest must reject this
        // The command is required (per daedalus ruling C-04456) to call these after writing.
        // If the generated output were malformed, the command must exit nonzero.
        let threw = false
        try {
          const badManifest = await resolver.readSpaceManifestFromFilesystem(
            'validate-gate-space',
            { cwd: repoPath }
          )
          const badResult = resolver.validateSpaceManifest(badManifest)
          // If parse succeeds but validation fails, that also counts
          if (!badResult.valid) threw = true
        } catch {
          threw = true
        }
        expect(threw).toBe(true)
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )
})

// ============================================================================
// Test 6 — Compatibility: asp spaces init still works (T-04410 daedalus #6)
// ============================================================================
describe('asp spaces init compatibility (T-04410 #6)', () => {
  test(
    'asp spaces init still creates a valid space alongside asp repo new-space',
    async () => {
      const { aspHome, repoPath } = await setupTempRegistry()
      try {
        // Run new command (RED now — command absent)
        const newResult = runAsp(['repo', 'new-space', 'new-cmd-space', '--asp-home', aspHome])
        expect(newResult.exitCode).toBe(0)

        // Run existing command (currently GREEN — tests regression)
        const initResult = runAsp(['spaces', 'init', 'legacy-cmd-space', '--asp-home', aspHome])
        expect(initResult.exitCode).toBe(0)

        // Both spaces must exist and produce valid manifests
        const newManifest = await resolver.readSpaceManifestFromFilesystem('new-cmd-space', {
          cwd: repoPath,
        })
        const newValidation = resolver.validateSpaceManifest(newManifest)
        expect(newValidation.valid).toBe(true)
        expect(newManifest.id).toBe('new-cmd-space')

        const legacyManifest = await resolver.readSpaceManifestFromFilesystem('legacy-cmd-space', {
          cwd: repoPath,
        })
        const legacyValidation = resolver.validateSpaceManifest(legacyManifest)
        expect(legacyValidation.valid).toBe(true)
        expect(legacyManifest.id).toBe('legacy-cmd-space')

        // Both should produce the same schema version and plugin structure
        expect(newManifest.plugin?.name).toBe('new-cmd-space')
        expect(legacyManifest.plugin?.name).toBe('legacy-cmd-space')

        // new-space must NOT have example.md; spaces init does (compat difference)
        expect(
          await exists(join(repoPath, 'spaces', 'new-cmd-space', 'commands', 'example.md'))
        ).toBe(false)
        expect(
          await exists(join(repoPath, 'spaces', 'legacy-cmd-space', 'commands', 'example.md'))
        ).toBe(true)
      } finally {
        await rm(aspHome, { recursive: true, force: true })
      }
    },
    CLI_TEST_TIMEOUT_MS
  )
})
