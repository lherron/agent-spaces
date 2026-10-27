/**
 * Slot sections in the context resolver: open-ended agent-profile dot-paths
 * resolve to file refs or exec commands, and their inspection reports classify
 * unconfigured/empty slots as skipped and wrong-typed or failing ones as failed
 * (T-06966, T-06969). Templates and agent profiles are real TOML files resolved
 * through inspectAgentSystemPrompt.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ResolverRoots,
  SECTION_SEPARATOR,
  createResolverRoots,
  inspectTemplate,
  removeResolverRoots,
  resolverContext,
} from './test-support/context-resolver-fixture.js'

const ADDITIONAL_BASE_SLOT = `
schema_version = 2

[[prompt]]
name = "additional-base"
type = "slot"
source = "instructions.additionalBase"
`

describe('resolveContextTemplate slot sections', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test('slot dot-paths in agent-profile.toml resolve to file refs and exec commands', async () => {
    await writeFile(join(roots.agentRoot, 'base-agent.md'), 'Agent base')
    await writeFile(join(roots.projectRoot, 'base-project.md'), 'Project base')
    await writeFile(join(roots.agentsRoot, 'session-banner.md'), 'Session banner')

    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[prompt]]
name = "additional-base"
type = "slot"
source = "instructions.additionalBase"

[[reminder]]
name = "session-context"
type = "slot"
source = "session.additionalContext"

[[reminder]]
name = "session-exec"
type = "slot"
source = "session.additionalExec"
`,
      {
        profileToml: `
[instructions]
additionalBase = ["agent-root:///base-agent.md", "project-root:///base-project.md"]

[session]
additionalContext = ["session-banner.md"]
additionalExec = ["printf 'task context'", "printf '\\\\nqueue context'"]
`,
      }
    )

    expect(inspection.prompt).toMatchObject({
      content: 'Agent base\n\nProject base',
      mode: 'replace',
    })
    expect(inspection.reminder.content).toBe(
      `Session banner${SECTION_SEPARATOR}task context\nqueue context`
    )
  })

  test.each([
    ['absent from the profile', '[instructions]\n'],
    ['an empty string', 'instructions.additionalBase = ""\n'],
    ['an empty array', 'instructions.additionalBase = []\n'],
    ['an array containing only empty strings', 'instructions.additionalBase = ["", ""]\n'],
  ])(
    'T-06966/T-06969 a slot that is %s is skipped as empty, not failed',
    async (_label, profileToml) => {
      const inspection = await inspectTemplate(roots, ADDITIONAL_BASE_SLOT, { profileToml })

      expect(inspection.prompt.content).toBe('')
      expect(inspection.prompt.sections[0]).toMatchObject({
        included: false,
        skippedReason: 'empty',
        disposition: { kind: 'skipped', reason: 'empty' },
      })
    }
  )

  // The `table` row is also the T-06966 wrong-typed slot source regression.
  // TOML (as parsed by @iarna/toml) cannot express a mixed-type array, so the
  // mixed-array row reaches inspection through its resolverContext passthrough.
  test.each([
    { label: 'number', profileToml: 'instructions.additionalBase = 42\n' },
    {
      label: 'table',
      profileToml: '[instructions.additionalBase]\nref = "agent-root:///base-agent.md"\n',
    },
    { label: 'mixed array', agentProfile: { instructions: { additionalBase: ['ok.md', 42] } } },
  ])(
    'T-06969 a present wrong-typed $label slot fails with the type reason',
    async ({ profileToml, agentProfile }) => {
      const inspection = await inspectTemplate(roots, ADDITIONAL_BASE_SLOT, {
        profileToml,
        ...(agentProfile !== undefined
          ? { resolverContext: resolverContext(roots, { agentProfile }) }
          : {}),
      })

      expect(inspection.prompt.content).toBe('')
      expect(inspection.prompt.sections[0]).toMatchObject({
        included: false,
        disposition: {
          kind: 'failed',
          source: { kind: 'slot', source: 'instructions.additionalBase' },
          reason:
            'Slot source instructions.additionalBase must resolve to a string or string array',
        },
      })
    }
  )

  test('T-06966 a slot file escaping its root or a slot exec exiting non-zero fails with contribution detail', async () => {
    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[reminder]]
name = "additional-session"
type = "slot"
source = "session.additionalContext"

[[reminder]]
name = "additional-session-exec"
type = "slot"
source = "session.additionalExec"
`,
      {
        profileToml: `
[session]
additionalContext = ["agent-root:///../../outside.md"]
additionalExec = ["exit 19"]
`,
      }
    )

    const sections = inspection.reminder.sections
    expect(inspection.reminder.content).toBeUndefined()
    expect(sections[0]?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'slot', source: 'session.additionalContext' },
      reason: expect.stringContaining('Unreadable slot file agent-root:///../../outside.md'),
    })
    expect(sections[0]?.contributionRecords[0]?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'file', ref: 'agent-root:///../../outside.md' },
      reason: expect.stringMatching(/escapes.*root/i),
    })
    expect(sections[1]?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'slot', source: 'session.additionalExec' },
      reason: expect.stringMatching(/exit code: 19/i),
    })
    expect(sections[1]?.contributionRecords[0]?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'exec', command: 'exit 19' },
      reason: expect.stringMatching(/exit code: 19/i),
    })
  })
})
