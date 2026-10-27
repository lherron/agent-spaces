/**
 * T-09860 (amendment r2, EN-20230): the optional producer taskContext is one
 * preparation input shared by inspection, direct preparation, and launch.
 *
 * For the same placement and the same optional taskContext, all three surfaces
 * render identical prompt bytes and effectiveEnvironmentHash; a conflicting scope task is
 * refused as configured_context_mismatch; nothing renders synthesized task
 * metadata. Real in-process compiler + ASPC service, hermetic fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AspcService, createAspcService } from 'spaces-aspc'
import {
  type AspcCompileHarnessInvocationResponse,
  type AspcInspectRuntimePlacementResponse,
  type AspcPrepareProcessInvocationResponse,
  validateAspcInspectRuntimePlacementRequest,
  validateAspcPrepareProcessInvocationRequest,
} from 'spaces-aspc-protocol'
import { createRuntimeCompiler, runtimeDependencies } from '../src/runtime-compiler.js'

type UnknownRecord = Record<string, any>

const SCRUBBED_ENV_PREFIXES = ['ASP_', 'AGENT_', 'HRC_', 'WRKQ_', 'AGENTCHAT_ID']
const TASK = 'T-09860'
const ROLE = {
  taskId: TASK,
  phase: 'implement',
  role: 'implementer',
  requiredEvidenceKinds: ['test-run', 'commit'],
  hintsText: 'Keep it small.',
}
const ROLE_SECTION = [
  '## Current task context',
  `- Task ID: ${TASK}`,
  '- Phase: implement',
  '- Role: implementer',
  '- Required evidence: test-run, commit',
  '',
  '### Hints',
  'Keep it small.',
].join('\n')

const TEMPLATE = `schema_version = 2
mode = "append"

[[prompt]]
name = "ident"
type = "inline"
content = "IDENT task={{taskId}}"

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

let savedEnv: Record<string, string | undefined> = {}
let root = ''
let service: AspcService & UnknownRecord

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeAll(() => {
  savedEnv = { ...process.env }
  for (const key of Object.keys(process.env)) {
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key]
  }
  root = realpathSync.native(mkdtempSync('/tmp/t09860-ctx-'))
  write(
    join(root, 'home', 'config.toml'),
    `agents-root = ${JSON.stringify(join(root, 'roster'))}\n`
  )
  write(
    join(root, 'roster', 'pov', 'agent-profile.toml'),
    'version = 4\n\n[spaces]\nbase = []\n\n[provisioning]\nharness = "codex"\n'
  )
  write(join(root, 'roster', 'pov', 'SOUL.md'), '# pov soul')
  write(join(root, 'roster', 'pov', 'context-template.toml'), TEMPLATE)
  write(join(root, 'proj', 'asp-targets.toml'), 'schema = 2\n')
  const codex = join(root, 'codex')
  writeFileSync(
    codex,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 999.0.0"; exit 0; fi\nif [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then echo app-server; exit 0; fi\nexit 97\n'
  )
  chmodSync(codex, 0o755)
  process.env['ASP_HOME'] = join(root, 'home')
  process.env['ASP_CODEX_PATH'] = codex
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  service = createAspcService({
    compiler: createRuntimeCompiler(),
    runtimeDependencies,
  }) as AspcService & UnknownRecord
})

afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  rmSync(root, { recursive: true, force: true })
})

function correlation(scopeTask: string | undefined) {
  return {
    sessionRef: {
      scopeRef:
        scopeTask === undefined
          ? 'agent:pov:project:proj:role:implementer'
          : `agent:pov:project:proj:task:${scopeTask}`,
      laneRef: 'main',
    },
  }
}

function context(contextTaskId: string | undefined): UnknownRecord {
  const projectRoot = join(root, 'proj')
  return {
    agentId: 'pov',
    agentRoot: join(root, 'roster', 'pov'),
    project: { mode: 'root', projectRoot, projectId: 'proj' },
    cwd: projectRoot,
    runMode: 'task',
    ...(contextTaskId !== undefined ? { taskId: contextTaskId } : {}),
  }
}

async function compile(
  scopeTask: string | undefined,
  taskContext?: typeof ROLE
): Promise<AspcCompileHarnessInvocationResponse> {
  const projectRoot = join(root, 'proj')
  const ids = {
    requestId: 'req-t09860',
    operationId: 'op-t09860',
    hostSessionId: 'host-t09860',
    generation: 0,
    runtimeId: 'rt-t09860',
    invocationId: 'inv-t09860',
    traceId: 'trace-t09860',
  }
  return await service.compileHarnessInvocation({
    compileRequest: {
      schemaVersion: 'agent-runtime-compile-request/v2',
      agent: { id: 'pov' },
      identity: ids,
      placement: {
        agentRoot: join(root, 'roster', 'pov'),
        projectRoot,
        cwd: projectRoot,
        runMode: 'task',
        bundle: { kind: 'agent-project', agentName: 'pov', projectRoot },
        correlation: correlation(scopeTask),
        dryRun: true,
      },
      requested: {
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.6-terra',
        presentation: false,
      },
      materialization: taskContext !== undefined ? { taskContext } : {},
      hrcPolicy: {},
      correlation: ids,
    },
    aspHome: join(root, 'home'),
  } as never)
}

// contextTaskId defaults to the scope's task; null leaves the context taskId out.
async function inspect(
  scopeTask: string | undefined,
  taskContext?: typeof ROLE,
  contextTaskId: string | null = scopeTask ?? null
): Promise<AspcInspectRuntimePlacementResponse> {
  return await service.inspectRuntimePlacement({
    schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
    context: context(contextTaskId ?? undefined),
    preparationCorrelation: correlation(scopeTask),
    ...(taskContext !== undefined ? { preparationTaskContext: taskContext } : {}),
  } as never)
}

async function prepare(
  scopeTask: string | undefined,
  taskContext?: typeof ROLE,
  contextTaskId: string | null = scopeTask ?? null
): Promise<AspcPrepareProcessInvocationResponse> {
  return await service.prepareProcessInvocation({
    schemaVersion: 'aspc-prepare-process-invocation-request/v1',
    context: context(contextTaskId ?? undefined),
    preparationCorrelation: correlation(scopeTask),
    expected: { provider: 'openai', frontend: 'codex-cli' },
    launch: { interactionMode: 'headless', ioMode: 'pipes' },
    ...(taskContext !== undefined ? { taskContext } : {}),
  } as never)
}

async function threeSurfaces(scopeTask: string | undefined, taskContext?: typeof ROLE) {
  const compiled = await compile(scopeTask, taskContext)
  if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.diagnostics)}`)
  const inspected = await inspect(scopeTask, taskContext)
  if (!inspected.ok) throw new Error(`inspect failed: ${JSON.stringify(inspected.declaration)}`)
  const prepared = await prepare(scopeTask, taskContext)
  if (!prepared.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared)}`)
  const compiledPromptFile = compiled.plan.artifacts.systemPromptFile
  if (compiledPromptFile === undefined) throw new Error('compile produced no systemPromptFile')
  if (inspected.prompt.state !== 'present') {
    throw new Error(`expected a present prompt, got ${JSON.stringify(inspected.prompt)}`)
  }
  return {
    prompts: [
      readFileSync(compiledPromptFile, 'utf8'),
      inspected.prompt.value.systemPrompt,
      prepared.spec.prompts.system?.content,
    ],
    hashes: [
      compiled.effectiveEnvironmentHash,
      inspected.effectiveEnvironmentHash,
      prepared.effectiveEnvironmentHash,
    ],
    compiled,
    inspected,
    prepared,
  }
}

describe('T-09860 same inputs, same facts and hash on every surface', () => {
  test('role launch: all three render the real fields with one hash', async () => {
    const { prompts, hashes } = await threeSurfaces(TASK, ROLE)
    expect(new Set(prompts).size).toBe(1)
    expect(new Set(hashes).size).toBe(1)
    expect(prompts[0]).toContain(ROLE_SECTION)
  })

  test('ordinary task seat: all three render Task ID only, with a different hash', async () => {
    const plain = await threeSurfaces(TASK)
    const role = await threeSurfaces(TASK, ROLE)
    expect(new Set(plain.prompts).size).toBe(1)
    expect(new Set(plain.hashes).size).toBe(1)
    expect(plain.prompts[0]).toContain(`## Current task context\n- Task ID: ${TASK}`)
    expect(plain.prompts[0]).not.toContain('- Role:')
    expect(plain.hashes[0]).not.toBe(role.hashes[0])

    // Nothing renders synthesized inspection task metadata.
    const everything = JSON.stringify({
      prompts: plain.prompts,
      inspected: plain.inspected,
      compiled: plain.compiled,
    })
    expect(everything).not.toContain('agent-inspection"')
    expect(everything).not.toContain("role:'agent-inspection'")

    // The taskContext joins the hash: a hints change moves it on every surface, and the
    // same taskContext hashes the same again.
    const otherHints = await threeSurfaces(TASK, { ...ROLE, hintsText: 'Keep it smaller.' })
    expect(new Set(otherHints.hashes).size).toBe(1)
    expect(otherHints.hashes[0]).not.toBe(role.hashes[0])
    const again = await compile(TASK, ROLE)
    if (!again.ok) throw new Error(`compile failed: ${JSON.stringify(again.diagnostics)}`)
    expect(again.effectiveEnvironmentHash).toBe(role.hashes[0])
  })

  test('role scope without a task segment: identity unchanged, facts from taskContext', async () => {
    const { prompts, hashes, prepared } = await threeSurfaces(undefined, ROLE)
    expect(new Set(prompts).size).toBe(1)
    expect(new Set(hashes).size).toBe(1)
    expect(prompts[0]).toContain('IDENT task=\n')
    expect(prompts[0]).toContain(ROLE_SECTION)
    // taskContext supplies facts only: it never puts a task into the prepared exec env
    // (which carries the AGENT_* correlation keys; the compiled lockedEnv carries none).
    expect(prepared.spec.env).toHaveProperty('AGENT_SCOPE_REF')
    expect(prepared.spec.env).not.toHaveProperty('AGENT_TASK')
  })
})

describe('T-09860 conflicting task identity is refused before materialization', () => {
  // One row per scope form. contextTaskId stays out of the request unless it agrees with
  // the scope, so the only conflict is the scope's task against the taskContext's.
  const conflicts: Array<{ scopeTask: string; contextTaskId: string | null; taskId: string }> = [
    { scopeTask: TASK, contextTaskId: TASK, taskId: 'T-00001' },
    { scopeTask: 'primary', contextTaskId: null, taskId: TASK },
    { scopeTask: `${TASK}-b7p`, contextTaskId: null, taskId: TASK },
    { scopeTask: 'T-00001:role:implementer', contextTaskId: null, taskId: TASK },
  ]
  const surfaces = ['compile', 'inspect', 'prepare'] as const
  const cases = surfaces.flatMap((surface) =>
    conflicts.map((row) => [surface, row.scopeTask, row.taskId, row] as const)
  )

  test.each(cases)(
    'a taskContext for another task is refused as configured_context_mismatch on %s (scope task %s, taskContext %s)',
    async (surface, scopeTask, taskId, row) => {
      const taskContext = { ...ROLE, taskId }
      if (surface === 'compile') {
        const response = await compile(scopeTask, taskContext)
        expect(response.ok).toBe(false)
        expect(response.diagnostics.map((d) => d.code)).toEqual(['configured_context_mismatch'])
      } else if (surface === 'inspect') {
        expect(await inspect(scopeTask, taskContext, row.contextTaskId)).toMatchObject({
          ok: false,
          declaration: { failure: { kind: 'incompatible', code: 'configured_context_mismatch' } },
        })
      } else {
        const prepared = await prepare(scopeTask, taskContext, row.contextTaskId)
        expect(prepared).toMatchObject({
          ok: false,
          failure: { kind: 'incompatible', code: 'configured_context_mismatch' },
        })
        expect(Object.hasOwn(prepared, 'spec')).toBe(false)
      }
    }
  )
})

describe('T-09860 validators', () => {
  function issuesOf(validate: () => unknown): Array<{ path: string; code: string }> {
    try {
      validate()
    } catch (error) {
      return (error as { issues: Array<{ path: string; code: string }> }).issues
    }
    throw new Error('expected the validator to refuse the request')
  }

  test('a well-formed taskContext or preparationCorrelation is accepted; a malformed taskContext is refused at its path', () => {
    const inspectReq = {
      schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
      context: context(TASK),
      preparationTaskContext: ROLE,
    }
    expect(() => validateAspcInspectRuntimePlacementRequest(inspectReq)).not.toThrow()
    expect(() =>
      validateAspcInspectRuntimePlacementRequest({
        schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
        context: context(TASK),
        preparationCorrelation: correlation(TASK),
      })
    ).not.toThrow()
    expect(
      issuesOf(() =>
        validateAspcInspectRuntimePlacementRequest({
          ...inspectReq,
          preparationTaskContext: { ...ROLE, requiredEvidenceKinds: 'x' },
        })
      )
    ).toEqual([
      expect.objectContaining({
        path: 'params.preparationTaskContext.requiredEvidenceKinds',
        code: 'invalid_type',
      }),
    ])
    const prepareReq = {
      schemaVersion: 'aspc-prepare-process-invocation-request/v1',
      context: context(TASK),
      preparationCorrelation: correlation(TASK),
      expected: { provider: 'openai', frontend: 'codex-cli' },
      launch: { interactionMode: 'headless', ioMode: 'pipes' },
      taskContext: ROLE,
    }
    expect(() => validateAspcPrepareProcessInvocationRequest(prepareReq)).not.toThrow()
    expect(
      issuesOf(() =>
        validateAspcPrepareProcessInvocationRequest({
          ...prepareReq,
          taskContext: { ...ROLE, phase: undefined, extra: 1 },
        })
      )
    ).toEqual([
      expect.objectContaining({ path: 'params.taskContext.phase', code: 'required' }),
      expect.objectContaining({ path: 'params.taskContext.extra', code: 'forbidden_input' }),
    ])
  })
})
