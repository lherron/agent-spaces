/**
 * Slot sections in the context resolver: open-ended agent-profile dot-paths
 * resolve to file refs or exec commands, and their inspection reports classify
 * unconfigured/empty slots as skipped and wrong-typed or failing ones as failed
 * (T-06966, T-06969).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseContextTemplate } from './context-template.js'
import {
  type ResolverRoots,
  SECTION_SEPARATOR,
  createResolverRoots,
  removeResolverRoots,
  resolveDetailed,
  resolveZones,
} from './test-support/context-resolver-fixture.js'

const ADDITIONAL_BASE_SLOT = parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "additional-base"
type = "slot"
source = "instructions.additionalBase"
`)

describe('resolveContextTemplate slot sections', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test('resolves open-ended slot dot-paths for file refs and exec arrays', async () => {
    await writeFile(join(roots.agentRoot, 'base-agent.md'), 'Agent base')
    await writeFile(join(roots.projectRoot, 'base-project.md'), 'Project base')
    await writeFile(join(roots.agentsRoot, 'session-banner.md'), 'Session banner')

    const resolved = await resolveZones(
      roots,
      parseContextTemplate(`
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
`),
      {
        agentProfile: {
          instructions: {
            additionalBase: ['agent-root:///base-agent.md', 'project-root:///base-project.md'],
          },
          session: {
            additionalContext: ['session-banner.md'],
            additionalExec: ["printf 'task context'", "printf '\\nqueue context'"],
          },
        },
      }
    )

    expect(resolved).toEqual({
      prompt: {
        content: 'Agent base\n\nProject base',
        mode: 'replace',
      },
      reminder: `Session banner${SECTION_SEPARATOR}task context\nqueue context`,
    })
  })

  test('T-06966 classifies an unconfigured slot as empty instead of failed', async () => {
    const resolved = await resolveDetailed(roots, ADDITIONAL_BASE_SLOT, { agentProfile: {} })

    expect(resolved.prompt).toBeUndefined()
    expect(resolved.promptSections[0]).toMatchObject({
      included: false,
      skippedReason: 'empty',
      disposition: { kind: 'skipped', reason: 'empty' },
    })
  })

  test.each([
    ['empty string', ''],
    ['empty array', []],
    ['array containing only empty strings', ['', '']],
  ])('T-06969 classifies a present %s slot as empty instead of failed', async (_label, value) => {
    const resolved = await resolveDetailed(roots, ADDITIONAL_BASE_SLOT, {
      agentProfile: { instructions: { additionalBase: value } },
    })

    expect(resolved.prompt).toBeUndefined()
    expect(resolved.promptSections[0]).toMatchObject({
      included: false,
      skippedReason: 'empty',
      disposition: { kind: 'skipped', reason: 'empty' },
    })
  })

  // The `object` row is also the T-06966 wrong-typed slot source regression.
  test.each([
    ['number', 42],
    ['object', { ref: 'agent-root:///base-agent.md' }],
    ['mixed array', ['agent-root:///base-agent.md', 42]],
  ])('T-06969 keeps a present wrong-typed %s slot failed', async (_label, value) => {
    const resolved = await resolveDetailed(roots, ADDITIONAL_BASE_SLOT, {
      agentProfile: { instructions: { additionalBase: value } },
    })

    expect(resolved.prompt).toBeUndefined()
    expect(resolved.promptSections[0]).toMatchObject({
      included: false,
      disposition: {
        kind: 'failed',
        source: { kind: 'slot', source: 'instructions.additionalBase' },
        reason: 'Slot source instructions.additionalBase must resolve to a string or string array',
      },
    })
  })

  test('T-06966 keeps file and exec slot resolution errors failed with contribution detail', async () => {
    const resolved = await resolveDetailed(
      roots,
      parseContextTemplate(`
schema_version = 2

[[reminder]]
name = "additional-session"
type = "slot"
source = "session.additionalContext"

[[reminder]]
name = "additional-session-exec"
type = "slot"
source = "session.additionalExec"
`),
      {
        agentProfile: {
          session: {
            additionalContext: ['agent-root:///../../outside.md'],
            additionalExec: ['exit 19'],
          },
        },
      }
    )

    expect(resolved.reminder).toBeUndefined()
    expect(resolved.reminderSections[0]?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'slot', source: 'session.additionalContext' },
      reason: expect.stringContaining('Unreadable slot file agent-root:///../../outside.md'),
    })
    expect(resolved.reminderSections[0]?.contributionRecords[0]?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'file', ref: 'agent-root:///../../outside.md' },
      reason: expect.stringMatching(/escapes.*root/i),
    })
    expect(resolved.reminderSections[1]?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'slot', source: 'session.additionalExec' },
      reason: expect.stringMatching(/exit code: 19/i),
    })
    expect(resolved.reminderSections[1]?.contributionRecords[0]?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'exec', command: 'exit 19' },
      reason: expect.stringMatching(/exit code: 19/i),
    })
  })
})
