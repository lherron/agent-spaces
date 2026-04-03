/**
 * Red/green ownership for wrkq T-01014.
 *
 * Spec sources:
 * - SYSTEM_PROMPT_RESOLUTION.md, "Implementation plan" Step 2
 * - agentchat DM #2518 from human@agent-spaces to animata@agent-spaces
 *
 * These tests define the template resolver contract before implementation
 * exists. Keep the scenarios aligned with the task's red-run history so a
 * future session can confirm the intended E2E behavior without re-reading the
 * full design discussion.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveSystemPromptTemplate } from './system-prompt-resolver.js'
import type { SystemPromptTemplate } from './system-prompt-template.js'

describe('resolveSystemPromptTemplate', () => {
  let tempRoot: string
  let agentRoot: string
  let agentsRoot: string
  let projectRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(process.cwd(), '.tmp-system-prompt-resolver-'))
    agentRoot = join(tempRoot, 'agent')
    agentsRoot = join(tempRoot, 'agents')
    projectRoot = join(tempRoot, 'project')

    await mkdir(agentRoot, { recursive: true })
    await mkdir(agentsRoot, { recursive: true })
    await mkdir(projectRoot, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('reads file content from agent-root refs', async () => {
    await writeFile(join(agentRoot, 'SOUL.md'), 'Agent soul content\n')

    const resolved = await resolve(
      templateFromSections([
        {
          name: 'soul',
          type: 'file',
          path: 'agent-root:///SOUL.md',
        },
      ])
    )

    expect(resolved).toEqual({
      content: 'Agent soul content\n',
      mode: 'replace',
    })
  })

  test('skips a missing non-required file section', async () => {
    const resolved = await resolve(
      templateFromSections([
        {
          name: 'missing-optional',
          type: 'file',
          path: 'agent-root:///OPTIONAL.md',
        },
      ])
    )

    expect(resolved).toBeUndefined()
  })

  test('throws when a required file section is missing', async () => {
    await expect(
      resolve(
        templateFromSections([
          {
            name: 'missing-required',
            type: 'file',
            path: 'agent-root:///REQUIRED.md',
            required: true,
          },
        ])
      )
    ).rejects.toThrow(/REQUIRED\.md/)
  })

  test('uses inline section content directly', async () => {
    const resolved = await resolve(
      templateFromSections([
        {
          name: 'inline-notice',
          type: 'inline',
          content: 'Inline section content',
        },
      ])
    )

    expect(resolved).toEqual({
      content: 'Inline section content',
      mode: 'replace',
    })
  })

  test('captures exec stdout and trims trailing whitespace', async () => {
    const resolved = await resolve(
      templateFromSections([
        {
          name: 'environment',
          type: 'exec',
          command: "printf 'runtime details\\n\\n'",
        },
      ])
    )

    expect(resolved).toEqual({
      content: 'runtime details',
      mode: 'replace',
    })
  })

  test('silently skips exec sections when the command fails or times out', async () => {
    const resolved = await resolve(
      templateFromSections([
        {
          name: 'timeout',
          type: 'exec',
          command: 'sleep 1',
          timeout: 10,
        },
        {
          name: 'failure',
          type: 'exec',
          command: 'exit 7',
        },
      ])
    )

    expect(resolved).toBeUndefined()
  })

  test('resolves additional-base refs from the profile and concatenates them', async () => {
    await writeFile(join(agentRoot, 'base-agent.md'), 'Agent-local base')
    await writeFile(join(projectRoot, 'base-project.md'), 'Project base')
    await writeFile(join(agentsRoot, 'base-global.md'), 'Global base')

    const resolved = await resolve(
      templateFromSections([
        {
          name: 'additional-base',
          type: 'slot',
        },
      ]),
      {
        agentProfile: {
          instructions: {
            additionalBase: [
              'agent-root:///base-agent.md',
              'project-root:///base-project.md',
              'base-global.md',
            ],
          },
        },
      }
    )

    expect(resolved).toEqual({
      content: 'Agent-local base\n\nProject base\n\nGlobal base',
      mode: 'replace',
    })
  })

  test('concatenates scaffold packet content and refs for the scaffold slot', async () => {
    await writeFile(join(agentRoot, 'packet-agent.md'), 'Agent scaffold ref')
    await writeFile(join(agentsRoot, 'packet-global.md'), 'Global scaffold ref')

    const resolved = await resolve(
      templateFromSections([
        {
          name: 'scaffold',
          type: 'slot',
        },
      ]),
      {
        scaffoldPackets: [
          { slot: 'scaffold', content: 'Inline scaffold content' },
          { slot: 'scaffold', ref: 'agent-root:///packet-agent.md' },
          { slot: 'scaffold', ref: 'packet-global.md' },
        ],
      }
    )

    expect(resolved).toEqual({
      content: 'Inline scaffold content\n\nAgent scaffold ref\n\nGlobal scaffold ref',
      mode: 'replace',
    })
  })

  test('excludes sections when when.runMode does not match the current run mode', async () => {
    const resolved = await resolve(
      templateFromSections([
        {
          name: 'heartbeat-only',
          type: 'inline',
          content: 'Only in heartbeat',
          when: { runMode: 'heartbeat' },
        },
      ]),
      { runMode: 'task' }
    )

    expect(resolved).toBeUndefined()
  })

  test('includes sections when when.runMode matches the current run mode', async () => {
    const resolved = await resolve(
      templateFromSections([
        {
          name: 'heartbeat-only',
          type: 'inline',
          content: 'Only in heartbeat',
          when: { runMode: 'heartbeat' },
        },
      ]),
      { runMode: 'heartbeat' }
    )

    expect(resolved).toEqual({
      content: 'Only in heartbeat',
      mode: 'replace',
    })
  })

  test('joins multiple resolved sections with the documented separator', async () => {
    await writeFile(join(agentRoot, 'SOUL.md'), 'Soul body')

    const resolved = await resolve(
      templateFromSections([
        {
          name: 'soul',
          type: 'file',
          path: 'agent-root:///SOUL.md',
        },
        {
          name: 'notice',
          type: 'inline',
          content: 'Inline notice',
        },
        {
          name: 'environment',
          type: 'exec',
          command: "printf 'env status'",
        },
      ])
    )

    expect(resolved).toEqual({
      content: 'Soul body\n\n---\n\nInline notice\n\n---\n\nenv status',
      mode: 'replace',
    })
  })

  test('returns undefined when every section resolves to empty content', async () => {
    const resolved = await resolve(
      templateFromSections([
        {
          name: 'blank-inline',
          type: 'inline',
          content: '',
        },
        {
          name: 'blank-exec',
          type: 'exec',
          command: "printf ''",
        },
      ])
    )

    expect(resolved).toBeUndefined()
  })

  function templateFromSections(sections: SystemPromptTemplate['sections']): SystemPromptTemplate {
    return {
      schemaVersion: 1,
      mode: 'replace',
      sections,
    }
  }

  async function resolve(
    template: SystemPromptTemplate,
    overrides: Partial<ResolverOverrides> = {}
  ) {
    return resolveSystemPromptTemplate(template, {
      agentRoot,
      agentsRoot,
      projectRoot,
      runMode: 'task',
      ...overrides,
    })
  }
})

interface ResolverOverrides {
  agentProfile: {
    instructions?:
      | {
          additionalBase?: string[] | undefined
        }
      | undefined
  }
  projectRoot: string
  runMode: string
  scaffoldPackets: Array<{ slot: string; content?: string | undefined; ref?: string | undefined }>
}
