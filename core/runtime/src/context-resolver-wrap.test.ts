/**
 * Section wrap in the context resolver: prefix/suffix interpolate, apply after
 * resolution and before per-section truncation and zone joining, and never
 * produce orphan headings for empty content.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContextResolverContext } from './context-resolver.js'
import type { ContextSection } from './context-template.js'
import {
  type ResolverRoots,
  SECTION_SEPARATOR,
  createResolverRoots,
  removeResolverRoots,
  resolveDetailed,
  templateWith,
} from './test-support/context-resolver-fixture.js'

describe('resolveContextTemplate section wrap', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test('wraps resolved section content with interpolated prefix and suffix before zone joining', async () => {
    const resolved = await resolveDetailed(
      roots,
      templateWith({
        promptSections: [
          {
            name: 'identity',
            type: 'inline',
            content: 'Body',
            wrap: {
              prefix: '## {{ agent_name }}\n\n',
              suffix: '\n\nProject: {{ project_id }}',
            },
          },
          {
            name: 'tail',
            type: 'inline',
            content: 'Tail',
          },
        ],
      })
    )

    expect(resolved.prompt?.content).toBe(
      `## smokey\n\nBody\n\nProject: agent-spaces${SECTION_SEPARATOR}Tail`
    )
    expect(resolved.promptSections[0]).toMatchObject({
      content: '## smokey\n\nBody\n\nProject: agent-spaces',
      wrapped: true,
    })
  })

  test('skips empty raw content before wrap and does not emit orphan headings', async () => {
    const resolved = await resolveDetailed(
      roots,
      templateWith({
        reminderSections: [
          {
            name: 'empty-heading',
            type: 'inline',
            content: '',
            wrap: {
              prefix: '## Heading\n\n',
              suffix: '\nEnd',
            },
          },
        ],
      })
    )

    expect(resolved.reminder).toBeUndefined()
    expect(resolved.reminderSections[0]).toMatchObject({
      included: false,
      skippedReason: 'empty',
      wrapped: false,
    })
  })

  test('counts wrap text against per-section max_chars while preserving the wrap prefix', async () => {
    const resolved = await resolveDetailed(
      roots,
      templateWith({
        reminderSections: [
          {
            name: 'budgeted',
            type: 'inline',
            content: 'abcdefghijklmnopqrstuvwxyz',
            maxChars: 20,
            wrap: {
              prefix: '## Header\n',
              suffix: '',
            },
          },
        ],
      })
    )

    expect(resolved.reminderSections[0]).toMatchObject({
      content: '## Header\n[truncated]',
      chars: 21,
      bytes: 21,
      truncated: true,
      wrapped: true,
    })
    expect(resolved.reminder).toBe('## Header\n[truncated]')
  })

  test('computes truncation diagnostics from post-wrap content length', async () => {
    const resolved = await resolveDetailed(
      roots,
      templateWith({
        promptSections: [
          {
            name: 'raw-short-wrapped-long',
            type: 'inline',
            content: 'short',
            maxChars: 12,
            wrap: {
              prefix: 'prefix-',
              suffix: '-suffix',
            },
          },
        ],
      })
    )

    expect(resolved.promptSections[0]).toMatchObject({
      content: '[truncated]',
      chars: 11,
      bytes: 11,
      truncated: true,
      wrapped: true,
    })
  })

  test('sets wrapped false when wrap prefix and suffix interpolate to empty strings', async () => {
    const resolved = await resolveDetailed(
      roots,
      templateWith({
        reminderSections: [
          {
            name: 'empty-wrap',
            type: 'inline',
            content: 'body',
            wrap: {
              prefix: '',
              suffix: '',
            },
          },
          {
            name: 'absent-wrap',
            type: 'inline',
            content: 'plain',
          },
        ],
      })
    )

    expect(resolved.reminderSections.map((section) => section.wrapped)).toEqual([false, false])
  })

  test.each<{
    type: string
    zone: 'prompt' | 'reminder'
    section: ContextSection
    setup?: (r: ResolverRoots) => Promise<void>
    context?: Partial<ContextResolverContext>
  }>([
    {
      type: 'file',
      zone: 'prompt',
      section: {
        name: 'file-wrap',
        type: 'file',
        path: 'agent-root:///wrapped-file.md',
        required: true,
        wrap: { prefix: '<file>', suffix: '</file>' },
      },
      setup: (r) => writeFile(join(r.agentRoot, 'wrapped-file.md'), 'file body'),
    },
    {
      type: 'inline',
      zone: 'prompt',
      section: {
        name: 'inline-wrap',
        type: 'inline',
        content: 'inline body',
        wrap: { prefix: '<inline>', suffix: '</inline>' },
      },
    },
    {
      type: 'exec',
      zone: 'reminder',
      section: {
        name: 'exec-wrap',
        type: 'exec',
        command: "printf 'exec body'",
        wrap: { prefix: '<exec>', suffix: '</exec>' },
      },
    },
    {
      type: 'slot',
      zone: 'reminder',
      section: {
        name: 'slot-wrap',
        type: 'slot',
        source: 'session.additionalContext',
        wrap: { prefix: '<slot>', suffix: '</slot>' },
      },
      setup: (r) => writeFile(join(r.agentRoot, 'slot-body.md'), 'slot body'),
      context: { agentProfile: { session: { additionalContext: ['agent-root:///slot-body.md'] } } },
    },
  ])('applies wrap to $type sections', async ({ type, zone, section, setup, context }) => {
    await setup?.(roots)

    const resolved = await resolveDetailed(
      roots,
      templateWith(
        zone === 'prompt' ? { promptSections: [section] } : { reminderSections: [section] }
      ),
      context
    )

    const rendered = zone === 'prompt' ? resolved.prompt?.content : resolved.reminder
    expect(rendered).toBe(`<${type}>${type} body</${type}>`)
  })

  test('applies wrap before SECTION_SEPARATOR joins resolved sections', async () => {
    const resolved = await resolveDetailed(
      roots,
      templateWith({
        reminderSections: [
          {
            name: 'first',
            type: 'inline',
            content: 'one',
            wrap: {
              prefix: '<first>',
              suffix: '</first>',
            },
          },
          {
            name: 'second',
            type: 'inline',
            content: 'two',
            wrap: {
              prefix: '<second>',
              suffix: '</second>',
            },
          },
        ],
      })
    )

    expect(resolved.reminder).toBe(`<first>one</first>${SECTION_SEPARATOR}<second>two</second>`)
  })
})
