/**
 * Zone assembly for the v2 context resolver (wrkq T-01043): prompt/reminder
 * zones resolve independently, sections join with SECTION_SEPARATOR, per-section
 * and global character budgets apply, and file/inline content interpolates
 * resolver variables. Each test writes a real context-template.toml and drives
 * it through inspectAgentSystemPrompt / materializeSystemPrompt.
 *
 * Spec sources: PROMPT_TEMPLATE_UPDATES.md ("v2 Template Format", "Design
 * decisions", "Resolver tests"); agentchat DM #26 and #29.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ResolverRoots,
  SECTION_SEPARATOR,
  createResolverRoots,
  inspectTemplate,
  materializeTemplate,
  removeResolverRoots,
} from './test-support/context-resolver-fixture.js'

describe('resolveContextTemplate zone assembly', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test('prompt and reminder sections materialize into separate files with root-relative file refs', async () => {
    await writeFile(join(roots.agentRoot, 'SOUL.md'), 'Agent soul\n')
    await writeFile(join(roots.projectRoot, 'README.md'), 'Project reminder\n')

    const files = await materializeTemplate(
      roots,
      `
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
`
    )

    expect(files).toEqual({
      systemPrompt: `Agent soul\n${SECTION_SEPARATOR}Prompt for smokey`,
      sessionReminder: `Project reminder\n${SECTION_SEPARATOR}Reminder for agent-spaces`,
    })
  })

  test('an inline or exec section over its max_chars is truncated with a marker before joining, in either zone', async () => {
    const inspection = await inspectTemplate(
      roots,
      `
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

[[reminder]]
name = "wrkq-context"
type = "exec"
command = "printf '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'"
max_chars = 24
`
    )

    expect(inspection.prompt.mode).toBe('replace')
    expect(inspection.prompt.content).toBe(`0123456789ABC[truncated]${SECTION_SEPARATOR}tail`)
    expect(inspection.reminder.content).toBe('0123456789ABC[truncated]')
    expect(inspection.prompt.sections[0]).toMatchObject({ name: 'services', truncated: true })
    expect(inspection.reminder.sections[0]).toMatchObject({
      name: 'wrkq-context',
      truncated: true,
    })
  })

  test('content over the global max_chars budget fails the template', async () => {
    await expect(
      inspectTemplate(
        roots,
        `
schema_version = 2
mode = "replace"
max_chars = 10

[[prompt]]
name = "too-large"
type = "inline"
content = "01234567890"
`
      )
    ).rejects.toThrow('Resolved context template exceeds max_chars 10 (got 11)')
  })

  test('inline content interpolates agent, project, root and run-mode variables', async () => {
    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[prompt]]
name = "identity"
type = "inline"
content = "You are {{agent_name}} in {{project_id}} at {{agent_root}} with run mode {{run_mode}}."
`
    )

    expect(inspection.prompt).toMatchObject({
      content: `You are smokey in agent-spaces at ${roots.agentRoot} with run mode task.`,
      mode: 'replace',
    })
    expect(inspection.reminder.content).toBeUndefined()
  })

  test('file section content is interpolated after it is read', async () => {
    await writeFile(
      join(roots.agentRoot, 'MOTD.md'),
      'You are {{agent_name}} in {{project_id}} at {{agent_root}} with run mode {{run_mode}}.\n'
    )

    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[prompt]]
name = "motd"
type = "file"
path = "agent-root:///MOTD.md"
required = true
`
    )

    expect(inspection.prompt).toMatchObject({
      content: `You are smokey in agent-spaces at ${roots.agentRoot} with run mode task.\n`,
      mode: 'replace',
    })
    expect(inspection.reminder.content).toBeUndefined()
  })
})
