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
 */

import { describe, expect, test } from 'bun:test'
import { must } from '../../test-support/must.js'

import type { ProjectManifest } from './targets.js'
// mergeManifests does not exist yet — this import will cause a compile/runtime error (RED)
import { mergeManifests } from './targets.js'

describe('mergeManifests', () => {
  // -- Helpers --

  const defaultsManifest: ProjectManifest = {
    schema: 2,
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
    schema: 2,
    claude: {
      model: 'claude-3-sonnet',
    },
    targets: {
      dev: {
        description: 'Dev target',
        compose: ['space:dev@latest'],
        provisioning: { claude: { model: 'claude-3-haiku' } },
      },
    },
  }

  // -- Target merge tests --

  test('target exists in both → project wins entirely (no field-level merge)', () => {
    const defaults: ProjectManifest = {
      schema: 2,
      targets: {
        overlap: {
          description: 'Default description',
          compose: ['space:defaults@stable'],
          provisioning: { claude: { model: 'claude-3-opus' } },
        },
      },
    }
    const project: ProjectManifest = {
      schema: 2,
      targets: {
        overlap: {
          compose: ['space:project@latest'],
          // No description, no provisioning — project target replaces entirely
        },
      },
    }
    const result = mergeManifests(defaults, project)
    expect(must(result.targets['overlap']).compose).toEqual(['space:project@latest'])
    // Project target had no description → should be undefined, NOT inherited from defaults
    expect(must(result.targets['overlap']).description).toBeUndefined()
    // Project target had no provisioning → should be undefined, NOT inherited from defaults
    expect(must(result.targets['overlap']).provisioning).toBeUndefined()
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
      schema: 2,
      targets: { a: { compose: ['space:a@stable'] } },
    }
    const defaults: ProjectManifest = {
      schema: 2,
      claude: { model: 'claude-3-opus', permission_mode: 'auto' },
      targets: {},
    }
    const result = mergeManifests(defaults, project)
    expect(result.claude?.model).toBe('claude-3-opus')
    expect(result.claude?.permission_mode).toBe('auto')
  })

  test('top-level claude: only project has claude → result gets project claude', () => {
    const project: ProjectManifest = {
      schema: 2,
      claude: { model: 'claude-3-sonnet' },
      targets: { a: { compose: ['space:a@stable'] } },
    }
    const defaults: ProjectManifest = {
      schema: 2,
      targets: {},
    }
    const result = mergeManifests(defaults, project)
    expect(result.claude?.model).toBe('claude-3-sonnet')
  })

  // -- Top-level codex options merge --

  test('top-level codex options merge field-by-field (project overrides defaults per field)', () => {
    const defaults: ProjectManifest = {
      schema: 2,
      codex: {
        model: 'gpt-5.3-codex',
        model_reasoning_effort: 'high',
        model_reasoning_summary: 'concise',
        status_line: ['model', 'cwd'],
        approval_policy: 'on-request',
        sandbox_mode: 'workspace-write',
      },
      targets: {},
    }
    const project: ProjectManifest = {
      schema: 2,
      codex: {
        model: 'gpt-5.1-codex-mini',
        // every other field is unset → inherits from defaults
      },
      targets: { a: { compose: ['space:a@stable'] } },
    }
    const result = mergeManifests(defaults, project)
    expect(result.codex).toEqual({
      model: 'gpt-5.1-codex-mini',
      model_reasoning_effort: 'high',
      model_reasoning_summary: 'concise',
      status_line: ['model', 'cwd'],
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
    })
  })

  // -- Null/undefined defaults --

  test.each([null, undefined])('defaults %p → returns project as-is', (defaults) => {
    expect(mergeManifests(defaults, projectManifest)).toEqual(projectManifest)
  })

  // -- Edge: merged result has all targets from both sides --

  test('merged result has the union of target names, each side keeping its compose', () => {
    const result = mergeManifests(defaultsManifest, projectManifest)
    const names = Object.keys(result.targets).sort()
    expect(names).toEqual(['dev', 'shared'])
    expect(must(result.targets['shared']).compose).toEqual(['space:defaults@stable'])
    expect(must(result.targets['dev']).compose).toEqual(['space:dev@latest'])
  })
})
