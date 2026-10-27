/**
 * agent-project bundle composition (T-00993): agent-profile.toml spaces merged
 * with an optional project asp-targets.toml target (replace by default, merge
 * with dedup under compose_mode = "merge").
 *
 * The cwd default for agent-project lives in the m4 cwd rule table.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: create temp agent root with v2 profile + optional project root
// ─────────────────────────────────────────────────────────────────────────────

function createAgentRoot(tempDir: string, profileToml: string): string {
  const agentRoot = join(tempDir, 'agent-root')
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, 'SOUL.md'), '# Test Agent\nYou are a test agent.\n')
  writeFileSync(join(agentRoot, 'agent-profile.toml'), profileToml)
  return agentRoot
}

function createProjectRoot(tempDir: string, targetsToml: string): string {
  const projectRoot = join(tempDir, 'project-root')
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(projectRoot, 'asp-targets.toml'), targetsToml)
  return projectRoot
}

// ===================================================================
// T-00993 Phase 2.2: placement resolver handles agent-project bundle
// ===================================================================
describe('placement resolver: agent-project bundle (T-00993)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'phase2-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test.each<{
    row: string
    profile: string
    targets?: string
    projectRoot: boolean
    expected: string[]
  }>([
    {
      row: 'no projectRoot -> profile spaces.base for the run mode',
      profile: `
version = 4

[spaces]
base = ["space:defaults@dev"]

[spaces.modes.heartbeat]
base = ["space:heartbeat-extra@dev"]
`,
      projectRoot: false,
      expected: ['space:defaults@dev'],
    },
    {
      row: 'project target compose (default replace) -> project compose only',
      profile: '\nversion = 4\n\n[spaces]\nbase = ["space:agent-base@dev"]\n',
      targets: '\nschema = 2\n\n[targets.testagent]\ncompose = ["space:project-only@dev"]\n',
      projectRoot: true,
      expected: ['space:project-only@dev'],
    },
    {
      row: 'compose_mode = "merge" -> agent [a, b] + project [b, c] with b once',
      profile: '\nversion = 4\n\n[spaces]\nbase = ["space:a@dev", "space:b@dev"]\n',
      targets:
        '\nschema = 2\n\n[targets.testagent]\ncompose_mode = "merge"\ncompose = ["space:b@dev", "space:c@dev"]\n',
      projectRoot: true,
      expected: ['space:a@dev', 'space:b@dev', 'space:c@dev'],
    },
    {
      row: 'projectRoot without asp-targets.toml -> profile spaces',
      profile: '\nversion = 4\n\n[spaces]\nbase = ["space:fallback@dev"]\n',
      projectRoot: true,
      expected: ['space:fallback@dev'],
    },
  ])(
    'project target compose replaces profile spaces by default, merges and dedups with compose_mode=merge: $row',
    async ({ profile, targets, projectRoot: withProjectRoot, expected }) => {
      const agentRoot = createAgentRoot(tempDir, profile)
      let projectRoot: string | undefined
      if (targets !== undefined) {
        projectRoot = createProjectRoot(tempDir, targets)
      } else if (withProjectRoot) {
        projectRoot = join(tempDir, 'bare-project')
        mkdirSync(projectRoot, { recursive: true })
      }

      const { resolvePlacement } = await import('../resolver/placement-resolver.js')

      const result = await resolvePlacement({
        agentRoot,
        ...(projectRoot !== undefined ? { projectRoot } : {}),
        runMode: 'query',
        bundle: {
          kind: 'agent-project',
          agentName: 'testagent',
          ...(projectRoot !== undefined ? { projectRoot } : {}),
        },
      })

      expect(result.spaces.map((s) => s.ref)).toEqual(expected)
    }
  )
})
