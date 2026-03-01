/**
 * Tests for mergeManifests() — merge default-targets.toml with project asp-targets.toml
 *
 * RED/GREEN TDD: These tests are written BEFORE the implementation.
 * They MUST fail initially (red) and pass only after mergeManifests is implemented.
 *
 * Task: T-00806
 * Merge semantics:
 *   - Targets: full-override by name (project wins entirely, no field-level merge)
 *   - Top-level claude/codex options: field-level merge (project overrides defaults per field)
 *   - defaults null/undefined: returns project as-is
 *   - Both manifests must have schema: 1
 */

import { describe, expect, test } from 'bun:test'

import type { ProjectManifest } from './targets.js'
// mergeManifests does not exist yet — this import will cause a compile/runtime error (RED)
import { mergeManifests } from './targets.js'

describe('mergeManifests', () => {
  // -- Helpers --

  const defaultsManifest: ProjectManifest = {
    schema: 1,
    claude: {
      model: 'claude-3-opus',
      permission_mode: 'auto',
    },
    codex: {
      model: 'gpt-5.3-codex',
      approval_policy: 'on-request',
    },
    targets: {
      shared: {
        description: 'Shared defaults target',
        compose: ['space:defaults@stable'],
      },
    },
  }

  const projectManifest: ProjectManifest = {
    schema: 1,
    claude: {
      model: 'claude-3-sonnet',
    },
    targets: {
      dev: {
        description: 'Dev target',
        compose: ['space:dev@latest'],
        claude: { model: 'claude-3-haiku' },
      },
    },
  }

  // -- Target merge tests --

  test('target exists only in defaults → included in result', () => {
    const result = mergeManifests(defaultsManifest, projectManifest)
    expect(result.targets.shared).toBeDefined()
    expect(result.targets.shared.compose).toEqual(['space:defaults@stable'])
  })

  test('target exists only in project → included in result', () => {
    const result = mergeManifests(defaultsManifest, projectManifest)
    expect(result.targets.dev).toBeDefined()
    expect(result.targets.dev.compose).toEqual(['space:dev@latest'])
  })

  test('target exists in both → project wins entirely (no field-level merge)', () => {
    const defaults: ProjectManifest = {
      schema: 1,
      targets: {
        overlap: {
          description: 'Default description',
          compose: ['space:defaults@stable'],
          claude: { model: 'claude-3-opus' },
        },
      },
    }
    const project: ProjectManifest = {
      schema: 1,
      targets: {
        overlap: {
          compose: ['space:project@latest'],
          // No description, no claude — project target replaces entirely
        },
      },
    }
    const result = mergeManifests(defaults, project)
    expect(result.targets.overlap.compose).toEqual(['space:project@latest'])
    // Project target had no description → should be undefined, NOT inherited from defaults
    expect(result.targets.overlap.description).toBeUndefined()
    // Project target had no claude → should be undefined, NOT inherited from defaults
    expect(result.targets.overlap.claude).toBeUndefined()
  })

  // -- Top-level claude options merge --

  test('top-level claude options merge field-by-field (project overrides defaults per field)', () => {
    const result = mergeManifests(defaultsManifest, projectManifest)
    // project sets model → overrides default's model
    expect(result.claude?.model).toBe('claude-3-sonnet')
    // project does NOT set permission_mode → inherits from defaults
    expect(result.claude?.permission_mode).toBe('auto')
  })

  test('top-level claude: only defaults has claude → result gets defaults claude', () => {
    const project: ProjectManifest = {
      schema: 1,
      targets: { a: { compose: ['space:a@stable'] } },
    }
    const defaults: ProjectManifest = {
      schema: 1,
      claude: { model: 'claude-3-opus', permission_mode: 'auto' },
      targets: {},
    }
    const result = mergeManifests(defaults, project)
    expect(result.claude?.model).toBe('claude-3-opus')
    expect(result.claude?.permission_mode).toBe('auto')
  })

  test('top-level claude: only project has claude → result gets project claude', () => {
    const project: ProjectManifest = {
      schema: 1,
      claude: { model: 'claude-3-sonnet' },
      targets: { a: { compose: ['space:a@stable'] } },
    }
    const defaults: ProjectManifest = {
      schema: 1,
      targets: {},
    }
    const result = mergeManifests(defaults, project)
    expect(result.claude?.model).toBe('claude-3-sonnet')
  })

  // -- Top-level codex options merge --

  test('top-level codex options merge field-by-field (project overrides defaults per field)', () => {
    const defaults: ProjectManifest = {
      schema: 1,
      codex: {
        model: 'gpt-5.3-codex',
        approval_policy: 'on-request',
        sandbox_mode: 'workspace-write',
      },
      targets: {},
    }
    const project: ProjectManifest = {
      schema: 1,
      codex: {
        model: 'gpt-5.1-codex-mini',
        // approval_policy not set → inherits from defaults
        // sandbox_mode not set → inherits from defaults
      },
      targets: { a: { compose: ['space:a@stable'] } },
    }
    const result = mergeManifests(defaults, project)
    expect(result.codex?.model).toBe('gpt-5.1-codex-mini')
    expect(result.codex?.approval_policy).toBe('on-request')
    expect(result.codex?.sandbox_mode).toBe('workspace-write')
  })

  // -- Schema validation --

  test('result always has schema: 1', () => {
    const result = mergeManifests(defaultsManifest, projectManifest)
    expect(result.schema).toBe(1)
  })

  // -- Null/undefined defaults --

  test('defaults is null → returns project as-is', () => {
    const result = mergeManifests(null, projectManifest)
    expect(result).toEqual(projectManifest)
  })

  test('defaults is undefined → returns project as-is', () => {
    const result = mergeManifests(undefined, projectManifest)
    expect(result).toEqual(projectManifest)
  })

  // -- Edge: merged result has all targets from both sides --

  test('merged result has union of all target names', () => {
    const result = mergeManifests(defaultsManifest, projectManifest)
    const names = Object.keys(result.targets).sort()
    expect(names).toEqual(['dev', 'shared'])
  })
})
