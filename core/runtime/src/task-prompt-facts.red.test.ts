/**
 * T-09860 (amendment r2, EN-20230): typed task prompt facts.
 *
 * Task facts derive only from the preparation identity's wrkq task ID and an
 * optional producer taskContext — never from any environment — and a template
 * renders only fields that are really present.
 */

import { describe, expect, test } from 'bun:test'
import type { HrcTaskContext } from 'spaces-runtime-contracts'
import { resolveContextTemplateDetailed } from './context-resolver.js'
import { parseContextTemplate } from './context-template.js'
import { derivePromptTaskFacts } from './task-prompt-facts.js'

const TEMPLATE = `
schema_version = 2

[[prompt]]
name = "scope"
type = "inline"
content = "scope {{taskId}}"

[[prompt]]
name = "current-task-context"
type = "inline"
when = { taskField = "id" }
parts = [
  { content = "## Current task context" },
  { content = "- Task ID: {{task.id}}" },
  { content = "- Phase: {{task.phase}}", when = { taskField = "phase" } },
  { content = "- Role: {{task.role}}", when = { taskField = "role" } },
  { content = "- Required evidence: {{task.requiredEvidence}}", when = { taskField = "requiredEvidence" } },
  { content = "\\n### Hints\\n{{task.hints}}", when = { taskField = "hints" } },
]
`

const ROLE_CONTEXT: HrcTaskContext = {
  taskId: 'T-00042',
  phase: 'implement',
  role: 'implementer',
  requiredEvidenceKinds: ['test-run', 'commit'],
  hintsText: 'Keep it small.\nPush when green.',
}

async function render(input: {
  taskId?: string | undefined
  taskContext?: HrcTaskContext | undefined
  env?: Record<string, string> | undefined
}) {
  const resolved = await resolveContextTemplateDetailed(parseContextTemplate(TEMPLATE), {
    agentRoot: '/tmp/agent',
    agentsRoot: '/tmp',
    runMode: 'task',
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.taskContext !== undefined ? { taskContext: input.taskContext } : {}),
    env: input.env ?? {},
  })
  const section = resolved.promptSections.find((s) => s.name === 'current-task-context')
  return { prompt: resolved.prompt?.content ?? '', section }
}

describe('derivePromptTaskFacts', () => {
  test('standing and seat-name scopes have no task facts', () => {
    for (const taskId of [undefined, 'primary', 'minisvc', 'primary-nova', 'hrcstandup']) {
      expect(derivePromptTaskFacts({ taskId })).toBeUndefined()
    }
  })

  test('sub-seat scopes never invent a task ID (anchored regex)', () => {
    for (const taskId of ['T-08566-b7p', 'T-08505-cell1', 't-00001', 'T-', 'XT-00001']) {
      expect(derivePromptTaskFacts({ taskId })).toBeUndefined()
    }
  })

  test('ordinary wrkq task seat yields the task ID only', () => {
    expect(derivePromptTaskFacts({ taskId: 'T-09860' })).toEqual({ id: 'T-09860' })
  })

  test('taskContext supplies real fields and omits null, blank, and empty ones', () => {
    expect(derivePromptTaskFacts({ taskId: 'T-00042', taskContext: ROLE_CONTEXT })).toEqual({
      id: 'T-00042',
      phase: 'implement',
      role: 'implementer',
      requiredEvidence: ['test-run', 'commit'],
      hints: 'Keep it small.\nPush when green.',
    })
    expect(
      derivePromptTaskFacts({
        taskContext: {
          taskId: 'T-00042',
          phase: null,
          role: '  ',
          requiredEvidenceKinds: [],
          hintsText: '\n ',
        },
      })
    ).toEqual({ id: 'T-00042' })
  })

  test('taskContext facts apply to a scope with no task segment', () => {
    expect(derivePromptTaskFacts({ taskContext: ROLE_CONTEXT })?.id).toBe('T-00042')
  })
})

describe('current-task-context rendering', () => {
  test('standing seat renders no task section and no stray lines', async () => {
    const { prompt, section } = await render({ taskId: 'primary' })
    expect(prompt).toBe('scope primary')
    expect(section?.included).toBe(false)
    expect(section?.skippedReason).toBe('when')
  })

  test('ordinary task seat renders only the Task ID line', async () => {
    const { section } = await render({ taskId: 'T-09860' })
    expect(section?.content).toBe('## Current task context\n- Task ID: T-09860')
  })

  test('role launch renders every real field', async () => {
    const { section } = await render({ taskId: 'T-00042', taskContext: ROLE_CONTEXT })
    expect(section?.content).toBe(
      [
        '## Current task context',
        '- Task ID: T-00042',
        '- Phase: implement',
        '- Role: implementer',
        '- Required evidence: test-run, commit',
        '',
        '### Hints',
        'Keep it small.',
        'Push when green.',
      ].join('\n')
    )
  })

  test('absent fields produce no empty lines', async () => {
    const { section } = await render({
      taskId: 'T-00042',
      taskContext: { ...ROLE_CONTEXT, phase: null, requiredEvidenceKinds: [], hintsText: '' },
    })
    expect(section?.content).toBe(
      '## Current task context\n- Task ID: T-00042\n- Role: implementer'
    )
  })

  test('task facts are never read from the environment', async () => {
    const env = {
      HRC_TASK_ID: 'T-11111',
      HRC_TASK_PHASE: 'x',
      HRC_TASK_ROLE: 'y',
      HRC_TASK_HINTS: 'z',
    }
    const { prompt, section } = await render({ taskId: 'primary', env })
    expect(section?.included).toBe(false)
    expect(prompt).not.toContain('T-11111')
  })

  test('taskContext does not change identity-derived variables', async () => {
    const { prompt, section } = await render({ taskContext: ROLE_CONTEXT })
    expect(prompt.split('\n\n---\n\n')[0]?.trim()).toBe('scope')
    expect(section?.content).toContain('- Task ID: T-00042')
  })
})

describe('task-scoped split (codex shared-home delivery)', () => {
  async function detailed(input: { taskId?: string; taskContext?: HrcTaskContext }) {
    return resolveContextTemplateDetailed(parseContextTemplate(TEMPLATE), {
      agentRoot: '/tmp/agent',
      agentsRoot: '/tmp',
      runMode: 'task',
      ...input,
      env: {},
    })
  }

  test('no task facts: no split, so shared-home harnesses behave exactly as today', async () => {
    expect((await detailed({ taskId: 'primary' })).taskScoped).toBeUndefined()
  })

  test('the invariant prompt is byte-identical to the render without task facts', async () => {
    const standingSameScope = await detailed({ taskId: 'T-00042-b7p' })
    const role = await detailed({ taskId: 'T-00042', taskContext: ROLE_CONTEXT })
    expect(role.taskScoped?.prompt).toBe('scope T-00042')
    expect(standingSameScope.prompt?.content).toBe('scope T-00042-b7p')
    expect(role.taskScoped?.content.startsWith('## Current task context\n- Task ID: T-00042')).toBe(
      true
    )
    expect(role.prompt?.content).toBe(
      `${role.taskScoped?.prompt}\n\n---\n\n${role.taskScoped?.content}`
    )
  })
})

describe('template grammar', () => {
  test('parts and content are mutually exclusive', () => {
    expect(() =>
      parseContextTemplate(`
schema_version = 2
[[prompt]]
name = "x"
type = "inline"
content = "a"
parts = [{ content = "b" }]
`)
    ).toThrow(/content.*parts|parts.*content/)
  })

  test('unknown taskField is rejected', () => {
    expect(() =>
      parseContextTemplate(`
schema_version = 2
[[prompt]]
name = "x"
type = "inline"
content = "a"
when = { taskField = "owner" }
`)
    ).toThrow(/taskField/)
  })
})
