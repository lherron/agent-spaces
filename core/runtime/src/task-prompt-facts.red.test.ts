/**
 * T-09860 (amendment r2, EN-20230): typed task prompt facts.
 *
 * Task facts derive only from the preparation identity's wrkq task ID and an
 * optional producer taskContext — never from any environment — and a template
 * renders only fields that are really present.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HrcTaskContext } from 'spaces-runtime-contracts'
import { inspectAgentSystemPrompt, materializeSystemPrompt } from './system-prompt.js'

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

let tempRoot: string
let agentRoot: string
let agentsRoot: string
let outputRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'task-prompt-facts-'))
  agentsRoot = join(tempRoot, 'agents')
  agentRoot = join(agentsRoot, 'agent')
  outputRoot = join(tempRoot, 'out')
  await mkdir(agentRoot, { recursive: true })
  await writeFile(join(agentsRoot, 'context-template.toml'), TEMPLATE)
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

interface RenderInput {
  taskId?: string | undefined
  taskContext?: HrcTaskContext | undefined
  env?: Record<string, string> | undefined
}

function systemPromptInput(input: RenderInput) {
  return {
    agentRoot,
    agentsRoot,
    runMode: 'task' as const,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.taskContext !== undefined ? { taskContext: input.taskContext } : {}),
    env: input.env ?? {},
  }
}

async function render(input: RenderInput) {
  const inspected = await inspectAgentSystemPrompt(systemPromptInput(input))
  const section = inspected?.prompt.sections.find((s) => s.name === 'current-task-context')
  return { prompt: inspected?.prompt.content ?? '', section }
}

async function materialize(input: RenderInput) {
  const result = await materializeSystemPrompt(outputRoot, systemPromptInput(input))
  const onDisk = result ? await readFile(result.path, 'utf8') : undefined
  return { result, onDisk }
}

describe('current-task-context rendering', () => {
  test.each([undefined, 'primary', 'minisvc', 'primary-nova', 'hrcstandup'])(
    'standing seat renders no task section and no stray lines (scope %s)',
    async (taskId) => {
      const { prompt, section } = await render({ taskId })
      expect(prompt).toBe(`scope ${taskId ?? ''}`)
      expect(section?.included).toBe(false)
      expect(section?.skippedReason).toBe('when')
    }
  )

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

  test.each<{ label: string; taskContext: HrcTaskContext; expected: string }>([
    {
      label: 'null and empty',
      taskContext: { ...ROLE_CONTEXT, phase: null, requiredEvidenceKinds: [], hintsText: '' },
      expected: '## Current task context\n- Task ID: T-00042\n- Role: implementer',
    },
    {
      label: 'whitespace-only',
      taskContext: {
        ...ROLE_CONTEXT,
        phase: null,
        role: '  ',
        requiredEvidenceKinds: [],
        hintsText: '\n ',
      },
      expected: '## Current task context\n- Task ID: T-00042',
    },
  ])('absent fields produce no empty lines ($label)', async ({ taskContext, expected }) => {
    const { section } = await render({ taskId: 'T-00042', taskContext })
    expect(section?.content).toBe(expected)
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
  test('no task facts: no split, so shared-home harnesses behave exactly as today', async () => {
    const { result, onDisk } = await materialize({ taskId: 'primary' })
    expect(result?.taskScoped).toBeUndefined()
    expect(onDisk).toBe('scope primary')
  })

  test('the invariant prompt is byte-identical to the render without task facts', async () => {
    for (const subSeat of [
      'T-00042-b7p',
      'T-08566-b7p',
      'T-08505-cell1',
      't-00001',
      'T-',
      'XT-00001',
    ]) {
      const standingSameScope = await materialize({ taskId: subSeat })
      expect(standingSameScope.result?.taskScoped).toBeUndefined()
      expect(standingSameScope.onDisk).toBe(`scope ${subSeat}`)
    }
    const role = await materialize({ taskId: 'T-00042', taskContext: ROLE_CONTEXT })
    expect(role.result?.taskScoped?.prompt).toBe('scope T-00042')
    expect(
      role.result?.taskScoped?.content.startsWith('## Current task context\n- Task ID: T-00042')
    ).toBe(true)
    expect(role.onDisk).toBe(
      `${role.result?.taskScoped?.prompt}\n\n---\n\n${role.result?.taskScoped?.content}`
    )
  })
})
