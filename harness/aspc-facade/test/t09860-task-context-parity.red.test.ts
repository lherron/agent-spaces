/**
 * T-09860 (amendment r2, EN-20230): the optional producer taskContext is one
 * preparation input shared by inspection, direct preparation, and launch.
 *
 * For the same placement and the same optional taskContext, all three surfaces
 * render identical prompt bytes and effectiveEnvironmentHash; each advertises
 * its taskContext input by an exact capability; a conflicting scope task is
 * refused as configured_context_mismatch; nothing renders synthesized task
 * metadata. Real in-process compiler + ASPC service, hermetic fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AspcService, createAspcService } from 'spaces-aspc'
import {
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

function context(scopeTask: string | undefined): UnknownRecord {
  const projectRoot = join(root, 'proj')
  return {
    agentId: 'pov',
    agentRoot: join(root, 'roster', 'pov'),
    project: { mode: 'root', projectRoot, projectId: 'proj' },
    cwd: projectRoot,
    runMode: 'task',
    ...(scopeTask !== undefined ? { taskId: scopeTask } : {}),
  }
}

async function compile(scopeTask: string | undefined, taskContext?: typeof ROLE) {
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
  const response = (await service.compileHarnessInvocation({
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
  } as never)) as UnknownRecord
  return response
}

async function inspect(scopeTask: string | undefined, taskContext?: typeof ROLE) {
  return (await service.inspectRuntimePlacement({
    schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
    context: context(scopeTask),
    preparationCorrelation: correlation(scopeTask),
    ...(taskContext !== undefined ? { preparationTaskContext: taskContext } : {}),
  } as never)) as UnknownRecord
}

async function prepare(scopeTask: string | undefined, taskContext?: typeof ROLE) {
  return (await service.prepareProcessInvocation({
    schemaVersion: 'aspc-prepare-process-invocation-request/v1',
    context: context(scopeTask),
    preparationCorrelation: correlation(scopeTask),
    expected: { provider: 'openai', frontend: 'codex-cli' },
    launch: { interactionMode: 'headless', ioMode: 'pipes' },
    ...(taskContext !== undefined ? { taskContext } : {}),
  } as never)) as UnknownRecord
}

async function threeSurfaces(scopeTask: string | undefined, taskContext?: typeof ROLE) {
  const compiled = await compile(scopeTask, taskContext)
  expect(compiled.ok, JSON.stringify(compiled.diagnostics)).toBe(true)
  const inspected = await inspect(scopeTask, taskContext)
  expect(inspected.ok, JSON.stringify(inspected.declaration)).toBe(true)
  const prepared = await prepare(scopeTask, taskContext)
  expect(prepared.ok, JSON.stringify(prepared.failure)).toBe(true)
  return {
    prompts: [
      readFileSync(compiled.plan.artifacts.systemPromptFile as string, 'utf8'),
      inspected.prompt.value.systemPrompt as string,
      prepared.spec.prompts.system.content as string,
    ],
    hashes: [
      compiled.effectiveEnvironmentHash,
      inspected.effectiveEnvironmentHash,
      prepared.effectiveEnvironmentHash,
    ],
    compiled,
    inspected,
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
  })

  test('role scope without a task segment: identity unchanged, facts from taskContext', async () => {
    const { prompts, hashes } = await threeSurfaces(undefined, ROLE)
    expect(new Set(prompts).size).toBe(1)
    expect(new Set(hashes).size).toBe(1)
    expect(prompts[0]).toContain('IDENT task=\n')
    expect(prompts[0]).toContain(ROLE_SECTION)
  })

  test('nothing renders synthesized inspection task metadata', async () => {
    const { prompts, inspected, compiled } = await threeSurfaces(TASK)
    const everything = JSON.stringify({ prompts, inspected, compiled })
    expect(everything).not.toContain('agent-inspection"')
    expect(everything).not.toContain("role:'agent-inspection'")
  })
})

describe('T-09860 conflicting task identity is refused before materialization', () => {
  const other = { ...ROLE, taskId: 'T-00001' }

  test('compile', async () => {
    const response = await compile(TASK, other)
    expect(response.ok).toBe(false)
    expect(response.diagnostics.map((d: UnknownRecord) => d.code)).toEqual([
      'configured_context_mismatch',
    ])
  })

  test('inspect', async () => {
    expect(await inspect(TASK, other)).toMatchObject({
      ok: false,
      declaration: { failure: { kind: 'incompatible', code: 'configured_context_mismatch' } },
    })
  })

  test('prepare', async () => {
    const prepared = await prepare(TASK, other)
    expect(prepared).toMatchObject({
      ok: false,
      failure: { kind: 'incompatible', code: 'configured_context_mismatch' },
    })
    expect(Object.hasOwn(prepared, 'spec')).toBe(false)
  })
})

describe('T-09860 capabilities and validators', () => {
  test('hello advertises both exact taskContext capabilities', async () => {
    const hello = (await service.hello({
      clientInfo: { name: 't09860' },
      protocolVersions: ['aspc/0.1'],
    })) as UnknownRecord
    expect(hello.capabilities.inspectRuntimePlacementPreparationTaskContext).toBe(true)
    expect(hello.capabilities.prepareProcessInvocationTaskContext).toBe(true)
  })

  test('validators accept a well-formed taskContext and reject a malformed one', () => {
    const inspectReq = {
      schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
      context: context(TASK),
      preparationTaskContext: ROLE,
    }
    expect(() => validateAspcInspectRuntimePlacementRequest(inspectReq)).not.toThrow()
    expect(() =>
      validateAspcInspectRuntimePlacementRequest({
        ...inspectReq,
        preparationTaskContext: { ...ROLE, requiredEvidenceKinds: 'x' },
      })
    ).toThrow()
    const prepareReq = {
      schemaVersion: 'aspc-prepare-process-invocation-request/v1',
      context: context(TASK),
      preparationCorrelation: correlation(TASK),
      expected: { provider: 'openai', frontend: 'codex-cli' },
      launch: { interactionMode: 'headless', ioMode: 'pipes' },
      taskContext: ROLE,
    }
    expect(() => validateAspcPrepareProcessInvocationRequest(prepareReq)).not.toThrow()
    expect(() =>
      validateAspcPrepareProcessInvocationRequest({
        ...prepareReq,
        taskContext: { ...ROLE, phase: undefined, extra: 1 },
      })
    ).toThrow()
  })
})
