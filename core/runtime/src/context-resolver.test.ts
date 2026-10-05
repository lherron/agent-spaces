/**
 * Zone assembly for the v2 context resolver (wrkq T-01043): prompt/reminder
 * zones resolve independently, sections join with SECTION_SEPARATOR, per-section
 * and global character budgets apply, and file/inline content interpolates
 * resolver variables. Real temp directories and file I/O, no mocks.
 *
 * Spec sources: PROMPT_TEMPLATE_UPDATES.md ("v2 Template Format", "Design
 * decisions", "Resolver tests"); agentchat DM #26 and #29.
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
  resolveZones,
} from './test-support/context-resolver-fixture.js'

describe('resolveContextTemplate zone assembly', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test('resolves prompt and reminder sections independently with root-relative file refs', async () => {
    await writeFile(join(roots.agentRoot, 'SOUL.md'), 'Agent soul\n')
    await writeFile(join(roots.projectRoot, 'README.md'), 'Project reminder\n')

    const resolved = await resolveZones(
      roots,
      parseContextTemplate(`
schema_version = 2
mode = "append"

[[prompt]]
name = "soul"
type = "file"
path = "agent-root:///SOUL.md"
required = true

[[prompt]]
name = "identity"
type = "inline"
content = "Prompt for {{agent_name}}"

[[reminder]]
name = "project-doc"
type = "file"
path = "project-root:///README.md"

[[reminder]]
name = "notice"
type = "inline"
content = "Reminder for {{project_id}}"
`),
      {
        runMode: 'task',
        projectId: 'agent-spaces',
        agentName: 'smokey',
      }
    )

    expect(resolved).toEqual({
      prompt: {
        content: `Agent soul\n${SECTION_SEPARATOR}Prompt for smokey`,
        mode: 'append',
      },
      reminder: `Project reminder\n${SECTION_SEPARATOR}Reminder for agent-spaces`,
    })
  })

  test('truncates section output with a truncated marker before joining', async () => {
    const resolved = await resolveZones(
      roots,
      parseContextTemplate(`
schema_version = 2
mode = "replace"

[[prompt]]
name = "services"
type = "inline"
content = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
max_chars = 24

[[prompt]]
name = "tail"
type = "inline"
content = "tail"
`)
    )

    expect(resolved.prompt).toBeDefined()
    expect(resolved.prompt?.mode).toBe('replace')
    expect(resolved.prompt?.content).toContain('[truncated]')
    expect(resolved.prompt?.content).toStartWith('0123456789AB')
    expect(resolved.prompt?.content).toEndWith(`${SECTION_SEPARATOR}tail`)
  })

  test('throws when resolved content exceeds the global max_chars budget', async () => {
    await expect(
      resolveZones(
        roots,
        parseContextTemplate(`
schema_version = 2
mode = "replace"
max_chars = 10

[[prompt]]
name = "too-large"
type = "inline"
content = "01234567890"
`)
      )
    ).rejects.toThrow(/max_chars|budget|exceeds/i)
  })

  test('interpolates inline variables from resolver context', async () => {
    const resolved = await resolveZones(
      roots,
      parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "identity"
type = "inline"
content = "You are {{agent_name}} in {{project_id}} at {{agent_root}} with run mode {{run_mode}}."
`)
    )

    expect(resolved.prompt).toEqual({
      content: `You are smokey in agent-spaces at ${roots.agentRoot} with run mode task.`,
      mode: 'replace',
    })
    expect(resolved.reminder).toBeUndefined()
  })

  test('interpolates file section content from resolver context', async () => {
    await writeFile(
      join(roots.agentRoot, 'MOTD.md'),
      'You are {{agent_name}} in {{project_id}} at {{agent_root}} with run mode {{run_mode}}.\n'
    )

    const resolved = await resolveZones(
      roots,
      parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "motd"
type = "file"
path = "agent-root:///MOTD.md"
required = true
`)
    )

    expect(resolved.prompt).toEqual({
      content: `You are smokey in agent-spaces at ${roots.agentRoot} with run mode task.\n`,
      mode: 'replace',
    })
    expect(resolved.reminder).toBeUndefined()
  })
})
