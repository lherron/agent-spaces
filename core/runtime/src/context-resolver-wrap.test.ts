/**
 * Section wrap in the context resolver: prefix/suffix interpolate, apply after
 * resolution and before per-section truncation and zone joining, and never
 * produce orphan headings for empty content. Templates are real
 * context-template.toml files (`[prompt.wrap]` / `[reminder.wrap]` tables)
 * resolved through inspectAgentSystemPrompt.
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
} from './test-support/context-resolver-fixture.js'

describe('resolveContextTemplate section wrap', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test('a [prompt.wrap] table wraps the section in its interpolated prefix and suffix before zone joining', async () => {
    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[prompt]]
name = "identity"
type = "inline"
content = "Body"

[prompt.wrap]
prefix = "## {{ agent_name }}\\n\\n"
suffix = "\\n\\nProject: {{ project_id }}"

[[prompt]]
name = "tail"
type = "inline"
content = "Tail"
`
    )

    expect(inspection.prompt.content).toBe(
      `## smokey\n\nBody\n\nProject: agent-spaces${SECTION_SEPARATOR}Tail`
    )
    expect(inspection.prompt.sections[0]).toMatchObject({
      content: '## smokey\n\nBody\n\nProject: agent-spaces',
      wrapped: true,
    })
  })

  // The parser rejects empty inline content, so the empty raw content comes
  // from an exec section that prints nothing.
  test('skips empty raw content before wrap and does not emit orphan headings', async () => {
    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[reminder]]
name = "empty-heading"
type = "exec"
command = "printf ''"

[reminder.wrap]
prefix = "## Heading\\n\\n"
suffix = "\\nEnd"
`
    )

    expect(inspection.reminder.content).toBeUndefined()
    expect(inspection.reminder.sections[0]).toMatchObject({
      included: false,
      skippedReason: 'empty',
      wrapped: false,
    })
  })

  test('counts wrap text against per-section max_chars while preserving the wrap prefix', async () => {
    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[reminder]]
name = "budgeted"
type = "inline"
content = "abcdefghijklmnopqrstuvwxyz"
max_chars = 20

[reminder.wrap]
prefix = "## Header\\n"
suffix = ""
`
    )

    expect(inspection.reminder.sections[0]).toMatchObject({
      content: '## Header\n[truncated]',
      chars: 21,
      bytes: 21,
      truncated: true,
      wrapped: true,
    })
    expect(inspection.reminder.content).toBe('## Header\n[truncated]')
  })

  test('computes truncation diagnostics from post-wrap content length', async () => {
    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[prompt]]
name = "raw-short-wrapped-long"
type = "inline"
content = "short"
max_chars = 12

[prompt.wrap]
prefix = "prefix-"
suffix = "-suffix"
`
    )

    expect(inspection.prompt.sections[0]).toMatchObject({
      content: '[truncated]',
      chars: 11,
      bytes: 11,
      truncated: true,
      wrapped: true,
    })
  })

  test('sets wrapped false when wrap prefix and suffix interpolate to empty strings', async () => {
    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[reminder]]
name = "empty-wrap"
type = "inline"
content = "body"

[reminder.wrap]
prefix = ""
suffix = ""

[[reminder]]
name = "absent-wrap"
type = "inline"
content = "plain"
`
    )

    expect(inspection.reminder.sections.map((section) => section.wrapped)).toEqual([false, false])
  })

  test.each<{
    type: string
    zone: 'prompt' | 'reminder'
    body: string
    setup?: (r: ResolverRoots) => Promise<void>
    profileToml?: string
  }>([
    {
      type: 'file',
      zone: 'prompt',
      body: 'type = "file"\npath = "agent-root:///wrapped-file.md"\nrequired = true',
      setup: (r) => writeFile(join(r.agentRoot, 'wrapped-file.md'), 'file body'),
    },
    {
      type: 'inline',
      zone: 'prompt',
      body: 'type = "inline"\ncontent = "inline body"',
    },
    {
      type: 'exec',
      zone: 'reminder',
      body: `type = "exec"\ncommand = "printf 'exec body'"`,
    },
    {
      type: 'slot',
      zone: 'reminder',
      body: 'type = "slot"\nsource = "session.additionalContext"',
      setup: (r) => writeFile(join(r.agentRoot, 'slot-body.md'), 'slot body'),
      profileToml: '[session]\nadditionalContext = ["agent-root:///slot-body.md"]\n',
    },
  ])('applies wrap to $type sections', async ({ type, zone, body, setup, profileToml }) => {
    await setup?.(roots)

    const inspection = await inspectTemplate(
      roots,
      `
schema_version = 2

[[${zone}]]
name = "${type}-wrap"
${body}

[${zone}.wrap]
prefix = "<${type}>"
suffix = "</${type}>"
`,
      { profileToml }
    )

    const rendered = zone === 'prompt' ? inspection.prompt.content : inspection.reminder.content
    expect(rendered).toBe(`<${type}>${type} body</${type}>`)
  })
})
