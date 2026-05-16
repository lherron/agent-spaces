/**
 * Red/green ownership for wrkq T-01043.
 *
 * Spec sources:
 * - PROMPT_TEMPLATE_UPDATES.md, sections "v2 Template Format",
 *   "Design decisions", and "Resolver tests"
 * - agentchat DM #26 and #29 from animata@agent-spaces to smokey@agent-spaces
 *
 * These tests intentionally stay red until the v2 context resolver exists and
 * implements the contract below. Use real temp directories and real file I/O so
 * future sessions can rerun the original failure shape without mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveContextTemplateDetailed } from './context-resolver.js'
import { type ContextTemplate, parseContextTemplate } from './context-template.js'

const SECTION_SEPARATOR = '\n\n---\n\n'
let agentRoot: string
let agentsRoot: string
let projectRoot: string

describe('resolveContextTemplate', () => {
  let tempRoot: string
  let originalCwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempRoot = await mkdtemp(join(process.cwd(), '.tmp-context-resolver-'))
    agentRoot = join(tempRoot, 'agent')
    agentsRoot = join(tempRoot, 'agents')
    projectRoot = join(tempRoot, 'project')

    await mkdir(agentRoot, { recursive: true })
    await mkdir(agentsRoot, { recursive: true })
    await mkdir(projectRoot, { recursive: true })
    process.chdir(projectRoot)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('resolves prompt and reminder sections independently with root-relative file refs', async () => {
    await writeFile(join(agentRoot, 'SOUL.md'), 'Agent soul\n')
    await writeFile(join(projectRoot, 'README.md'), 'Project reminder\n')

    const resolved = await resolve(
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
    const resolved = await resolve(
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
      resolve(
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

  test('gates sections on when.exists using the real cwd', async () => {
    await writeFile(join(projectRoot, 'justfile'), 'default:\n\t@echo ok\n')

    const resolved = await resolve(
      parseContextTemplate(`
schema_version = 2

[[reminder]]
name = "project-tooling"
type = "inline"
content = "Just is available"
when = { exists = "justfile" }

[[reminder]]
name = "missing-tooling"
type = "inline"
content = "Should not render"
when = { exists = "missing.file" }
`)
    )

    expect(resolved).toEqual({
      prompt: undefined,
      reminder: 'Just is available',
    })
  })

  test('resolves open-ended slot dot-paths for file refs and exec arrays', async () => {
    await writeFile(join(agentRoot, 'base-agent.md'), 'Agent base')
    await writeFile(join(projectRoot, 'base-project.md'), 'Project base')
    await writeFile(join(agentsRoot, 'session-banner.md'), 'Session banner')

    const resolved = await resolve(
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

  test('interpolates inline variables from resolver context', async () => {
    const resolved = await resolve(
      parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "identity"
type = "inline"
content = "You are {{agent_name}} in {{project_id}} at {{agent_root}} with run mode {{run_mode}}."
`)
    )

    expect(resolved.prompt).toEqual({
      content: `You are smokey in agent-spaces at ${agentRoot} with run mode task.`,
      mode: 'replace',
    })
    expect(resolved.reminder).toBeUndefined()
  })

  test('interpolates file section content from resolver context', async () => {
    await writeFile(
      join(agentRoot, 'MOTD.md'),
      'You are {{agent_name}} in {{project_id}} at {{agent_root}} with run mode {{run_mode}}.\n'
    )

    const resolved = await resolve(
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
      content: `You are smokey in agent-spaces at ${agentRoot} with run mode task.\n`,
      mode: 'replace',
    })
    expect(resolved.reminder).toBeUndefined()
  })

  test('rejects schema_version 1 templates', () => {
    expect(() =>
      parseContextTemplate(`
schema_version = 1

[[section]]
name = "legacy"
type = "inline"
content = "legacy prompt"
`)
    ).toThrow(/schema_version.*2/i)
  })

  test('skips exec sections when commands time out or exit non-zero', async () => {
    const resolved = await resolve(
      parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "timeout"
type = "exec"
command = "sleep 1"
timeout = 10

[[prompt]]
name = "failure"
type = "exec"
command = "exit 7"

[[prompt]]
name = "success"
type = "exec"
command = "printf 'ok'"
`)
    )

    expect(resolved).toEqual({
      prompt: {
        content: 'ok',
        mode: 'replace',
      },
      reminder: undefined,
    })
  })

  test('wraps resolved section content with interpolated prefix and suffix before zone joining', async () => {
    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
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
      }),
      defaultContext()
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
    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
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
      }),
      defaultContext()
    )

    expect(resolved.reminder).toBeUndefined()
    expect(resolved.reminderSections[0]).toMatchObject({
      included: false,
      skippedReason: 'empty',
      wrapped: false,
    })
  })

  test('counts wrap text against per-section max_chars while preserving the wrap prefix', async () => {
    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
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
      }),
      defaultContext()
    )

    expect(resolved.reminderSections[0]).toMatchObject({
      content: '## Header\n[truncated]',
      chars: 20,
      bytes: 20,
      truncated: true,
      wrapped: true,
    })
    expect(resolved.reminder).toBe('## Header\n[truncated]')
  })

  test('computes truncation diagnostics from post-wrap content length', async () => {
    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
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
      }),
      defaultContext()
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
    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
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
      }),
      defaultContext()
    )

    expect(resolved.reminderSections.map((section) => section.wrapped)).toEqual([false, false])
  })

  test('applies wrap to file sections', async () => {
    await writeFile(join(agentRoot, 'wrapped-file.md'), 'file body')

    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
        promptSections: [
          {
            name: 'file-wrap',
            type: 'file',
            path: 'agent-root:///wrapped-file.md',
            required: true,
            wrap: {
              prefix: '<file>',
              suffix: '</file>',
            },
          },
        ],
      }),
      defaultContext()
    )

    expect(resolved.prompt?.content).toBe('<file>file body</file>')
  })

  test('applies wrap to inline sections', async () => {
    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
        promptSections: [
          {
            name: 'inline-wrap',
            type: 'inline',
            content: 'inline body',
            wrap: {
              prefix: '<inline>',
              suffix: '</inline>',
            },
          },
        ],
      }),
      defaultContext()
    )

    expect(resolved.prompt?.content).toBe('<inline>inline body</inline>')
  })

  test('applies wrap to exec sections', async () => {
    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
        reminderSections: [
          {
            name: 'exec-wrap',
            type: 'exec',
            command: "printf 'exec body'",
            wrap: {
              prefix: '<exec>',
              suffix: '</exec>',
            },
          },
        ],
      }),
      defaultContext()
    )

    expect(resolved.reminder).toBe('<exec>exec body</exec>')
  })

  test('applies wrap to slot sections', async () => {
    await writeFile(join(agentRoot, 'slot-body.md'), 'slot body')

    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
        reminderSections: [
          {
            name: 'slot-wrap',
            type: 'slot',
            source: 'session.additionalContext',
            wrap: {
              prefix: '<slot>',
              suffix: '</slot>',
            },
          },
        ],
      }),
      defaultContext({
        agentProfile: {
          session: {
            additionalContext: ['agent-root:///slot-body.md'],
          },
        },
      })
    )

    expect(resolved.reminder).toBe('<slot>slot body</slot>')
  })

  test('applies wrap before SECTION_SEPARATOR joins resolved sections', async () => {
    const resolved = await resolveContextTemplateDetailed(
      templateWithWrap({
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
      }),
      defaultContext()
    )

    expect(resolved.reminder).toBe(`<first>one</first>${SECTION_SEPARATOR}<second>two</second>`)
  })
})

async function resolve(template: ContextTemplate, overrides?: Record<string, unknown>) {
  const resolver = await loadResolver()

  return resolver(template, {
    agentRoot,
    agentsRoot,
    projectRoot,
    projectId: 'agent-spaces',
    agentName: 'smokey',
    runMode: 'task',
    ...overrides,
  })
}

async function loadResolver(): Promise<
  (template: ContextTemplate, context: Record<string, unknown>) => Promise<unknown>
> {
  try {
    const module = (await import('./context-resolver.js')) as {
      resolveContextTemplate?: (
        template: ContextTemplate,
        context: Record<string, unknown>
      ) => Promise<unknown>
    }

    if (typeof module.resolveContextTemplate !== 'function') {
      throw new Error('Expected resolveContextTemplate export')
    }

    return module.resolveContextTemplate
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`T-01043 red test blocked by missing resolver implementation: ${message}`)
  }
}

function defaultContext(overrides?: Record<string, unknown>) {
  return {
    agentRoot,
    agentsRoot,
    projectRoot,
    projectId: 'agent-spaces',
    agentName: 'smokey',
    runMode: 'task',
    ...overrides,
  }
}

function templateWithWrap(overrides: Partial<ContextTemplate>): ContextTemplate {
  return {
    schemaVersion: 2,
    mode: 'replace',
    promptSections: [],
    reminderSections: [],
    ...overrides,
  } as ContextTemplate
}
