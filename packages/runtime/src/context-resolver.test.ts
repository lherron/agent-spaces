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
