import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateAgentInspectionRequest } from 'spaces-runtime-contracts'
import type {
  AgentInspectionEvaluationContext,
  AgentInspectionIdentity,
  AgentInspectionPart,
  AgentInspectionRequest,
  AgentInspectionResult,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import * as AgentSpaces from '../../compiler/agent-spaces/src/index.js'
import { compilerRuntime } from './compiler-runtime.js'

type CompileClient = {
  compileRuntimePlan(
    request: RuntimeCompileRequest,
    options?: {
      compileContext?: AgentInspectionEvaluationContext['compileContext'] | undefined
    }
  ): Promise<RuntimeCompileResponse>
}

type InspectionOutcome =
  | { ok: true; inspection: AgentInspectionResult }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }

type InspectAgentForContext = (
  input: { request: unknown; evaluationContext: unknown },
  options?: {
    compileRuntimePlan?: (
      request: RuntimeCompileRequest,
      options?: {
        compileContext?: AgentInspectionEvaluationContext['compileContext'] | undefined
      }
    ) => Promise<RuntimeCompileResponse>
  }
) => Promise<InspectionOutcome>

type StableCompileIdentity = {
  compileId: string
  planHash: string
  lockHash: string | null
  bundleIdentity: string
}

type Fixture = {
  root: string
  aspHome: string
  canonicalAgentsRoot: string
  projectRoot: string
  projectAgentsRoot: string
  agentRoot: string
  execCwd: string
}

const AGENT_ID = 'parity-agent'
const PINNED_NOW = '2026-07-18T12:34:56.000Z'
let fixture: Fixture

beforeEach(async () => {
  const createdRoot = await mkdtemp(join(tmpdir(), 'agent-inspection-dry-run-parity-'))
  const root = await realpath(createdRoot)
  const aspHome = join(root, 'asp-home')
  const canonicalAgentsRoot = join(root, 'canonical-agents')
  const projectRoot = join(root, 'project')
  const projectAgentsRoot = join(projectRoot, 'agents')
  const agentRoot = join(projectAgentsRoot, AGENT_ID)
  const canonicalAgentRoot = join(canonicalAgentsRoot, AGENT_ID)
  const execCwd = join(root, 'pinned-exec-cwd')
  for (const path of [aspHome, agentRoot, canonicalAgentRoot, execCwd]) {
    await mkdir(path, { recursive: true })
  }

  await writeFile(
    join(projectRoot, 'asp-targets.toml'),
    `schema = 2
agents-root = "agents"

[targets.${AGENT_ID}]
compose = []
`
  )
  await writeFile(
    join(agentRoot, 'agent-profile.toml'),
    `version = 4

[identity]
display = "Parity Agent"

[spaces]
base = []

[instructions]
template = "context-template.toml"
`
  )
  await writeFile(join(agentRoot, 'context-template.toml'), projectOverlayTemplate())
  await writeFile(join(canonicalAgentRoot, 'context-template.toml'), canonicalShadowTemplate())

  fixture = {
    root,
    aspHome,
    canonicalAgentsRoot,
    projectRoot,
    projectAgentsRoot,
    agentRoot,
    execCwd,
  }
})

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

describe('v2 inspection identity contract', () => {
  test('accepts the producer-owned harness and presentation identity', () => {
    const request: AgentInspectionRequest = {
      schemaVersion: 'agent-inspection-request/v2',
      identifiers: identifiers(),
      declaredOverrides: { modelId: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    }
    expect(validateAgentInspectionRequest(request)).toEqual(request)
  })

  test('fails closed for the retired selection-bearing inspection discriminator', () => {
    expect(() =>
      validateAgentInspectionRequest({
        schemaVersion: 'agent-inspection-request/v1',
        identifiers: identifiers(),
        declaredOverrides: {},
      })
    ).toThrow('Invalid compiled-agent inspection contract')
  })
})

describe('T-06331 contextual inspection parity with the singular compiled plan', () => {
  test('preserves the five-leg pinned fixture and singular plan identity', async () => {
    const compiled = await compilePinnedFixture()
    const expectedPrompt = expectedPromptBytes()
    expect(compiled.compileCount).toBe(1)
    expect(compiled.response.ok).toBe(true)
    expect(compiled.inspection.completeness).toEqual({
      kind: 'partial',
      missingPartIds: ['prompt:prompt:dynamic-failure'],
    })

    const promptParts = compiled.inspection.parts.filter((part) => part.kind === 'prompt')
    expect(promptParts.map((part) => part.partId)).toEqual([
      'prompt:prompt:project-overlay-first',
      'prompt:prompt:dynamic-success',
      'prompt:prompt:dynamic-failure',
      'prompt:prompt:predicate-skipped',
      'prompt:prompt:project-overlay-last',
    ])
    expect(promptBytes(promptParts)).toBe(expectedPrompt)
    expect(promptBytes(promptParts)).not.toContain('FAILED-EXEC-LEAK')
    expect(promptBytes(promptParts)).not.toContain('PREDICATE-SKIP-LEAK')
    expect(promptBytes(promptParts)).not.toContain('CANONICAL-SHADOW-LEAK')

    const failed = promptParts.find((part) => part.partId === 'prompt:prompt:dynamic-failure')
    expect(failed?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'exec' },
      reason: expect.stringMatching(/exit[ -]?code[^\n]*23/i),
    })
    expect(failed?.provenance.contributions.length).toBeGreaterThan(0)
    expect(
      promptParts.find((part) => part.partId === 'prompt:prompt:predicate-skipped')?.disposition
    ).toEqual({ kind: 'skipped', reason: 'predicate' })

    expect(compiled.inspection.parts.some((part) => part.kind === 'capability')).toBe(true)
    expect(compiled.inspection.parts.some((part) => part.kind === 'runtime-setting')).toBe(true)
    expect(stableIdentity(compiled.response, compiled.inspection)).toEqual({
      compileId: compiled.response.ok ? compiled.response.plan.compileId : '',
      planHash: compiled.response.ok ? compiled.response.plan.planHash : '',
      lockHash: compiled.response.ok ? (compiled.response.plan.artifacts.lockHash ?? null) : null,
      bundleIdentity: compiled.response.ok ? compiled.response.plan.artifacts.bundleIdentity : '',
    })
  })

  test('compiles the completely pinned fixture twice to identical canonical results', async () => {
    const first = await compilePinnedFixture()
    const second = await compilePinnedFixture()

    expect(first.compileCount).toBe(1)
    expect(second.compileCount).toBe(1)
    expect(second.response).toEqual(first.response)
    expect(second.inspection).toEqual(first.inspection)
    expect(stableIdentity(second.response, second.inspection)).toEqual(
      stableIdentity(first.response, first.inspection)
    )
  })

  test('preserves a partial inspection from one singular compile', async () => {
    const compiled = await compilePinnedFixture()
    expect(compiled.compileCount).toBe(1)
    expect(compiled.response.ok).toBe(true)
    expect(compiled.inspection.completeness.kind).toBe('partial')
    expect(compiled.inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'resolution',
        code: 'part_resolution_failed',
        partId: 'prompt:prompt:dynamic-failure',
      })
    )
  })
})

async function compilePinnedFixture(): Promise<{
  response: RuntimeCompileResponse
  inspection: AgentInspectionResult
  readonly compileCount: number
}> {
  const inspectAgentForContext = inspectionOperation()
  const client = AgentSpaces.createAgentSpacesClient({
    aspHome: fixture.aspHome,
    runtime: compilerRuntime,
  }) as CompileClient
  let compileCount = 0
  let response: RuntimeCompileResponse | undefined
  const outcome = await inspectAgentForContext(
    { request: inspectionRequest(), evaluationContext: evaluationContext() },
    {
      compileRuntimePlan: async (request, options) => {
        compileCount += 1
        response = await client.compileRuntimePlan(request, options)
        return response
      },
    }
  )
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  expect(response).toBeDefined()
  if (!outcome.ok || response === undefined) {
    throw new Error(`pinned inspection failed: ${JSON.stringify(outcome)}`)
  }
  return {
    response,
    inspection: outcome.inspection,
    get compileCount() {
      return compileCount
    },
  }
}

function inspectionOperation(): InspectAgentForContext {
  const operation = (AgentSpaces as Record<string, unknown>)['inspectAgentForContext']
  expect(operation).toBeFunction()
  return operation as InspectAgentForContext
}

function inspectionRequest(): AgentInspectionRequest {
  return {
    schemaVersion: 'agent-inspection-request/v2',
    identifiers: identifiers(),
    declaredOverrides: { modelId: 'gpt-5.5', reasoningEffort: 'medium' },
  }
}

function evaluationContext(): AgentInspectionEvaluationContext {
  return {
    schemaVersion: 'agent-inspection-evaluation-context/v2',
    identifiers: identifiers(),
    paths: {
      agentRoot: fixture.agentRoot,
      agentsRoot: fixture.canonicalAgentsRoot,
      projectRoot: fixture.projectRoot,
      cwd: fixture.projectRoot,
    },
    nowIso: PINNED_NOW,
    environment: { PINNED_PARITY_VALUE: 'explicit-value' },
    predicateInputs: { cwd: fixture.projectRoot, environment: {} },
    execInputs: {
      cwd: fixture.execCwd,
      environment: { PINNED_PARITY_VALUE: 'explicit-value' },
    },
    serviceProbeInputs: { responses: [] },
    scaffoldPackets: [],
    agentProfile: {},
    declaredOverrides: { modelId: 'gpt-5.5', reasoningEffort: 'medium' },
    compileContext: {
      nowIso: PINNED_NOW,
      idSalt: 't06331-inspection-dry-run-parity',
      toolchainManifest: {
        schemaVersion: 'compile-toolchain/v1',
        tools: [
          { name: 'agent-spaces', version: 'pinned-test' },
          { name: 'codex', version: 'pinned-test' },
        ],
      },
    },
  }
}

function identifiers(): AgentInspectionIdentity {
  return {
    agentId: AGENT_ID,
    agentName: 'Parity Agent',
    projectId: 'parity-project',
    mode: 'task',
    scope: `agent:${AGENT_ID}:project:parity-project:task:T-06331`,
    taskId: 'T-06331',
    lane: 'main',
    harness: 'codex',
    presentation: false,
  }
}

function promptBytes(parts: AgentInspectionPart[]): string {
  return parts
    .filter(
      (part) =>
        part.kind === 'prompt' &&
        part.disposition.kind === 'effective' &&
        part.value.zone === 'prompt'
    )
    .map((part) => (part.kind === 'prompt' ? (part.value.content ?? '') : ''))
    .join('\n\n---\n\n')
}

function expectedPromptBytes(): string {
  return [
    'project-overlay-first',
    `dynamic-success=${fixture.execCwd}:explicit-value`,
    'project-overlay-last',
  ].join('\n\n---\n\n')
}

function stableIdentity(
  response: RuntimeCompileResponse,
  inspection: AgentInspectionResult
): StableCompileIdentity {
  expect(response.ok).toBe(true)
  expect(inspection.freshness.kind).toBe('unknown')
  if (!response.ok) {
    throw new Error('pinned fixture must produce a successful canonical plan')
  }
  return {
    compileId: response.plan.compileId,
    planHash: response.plan.planHash,
    // Agent-project placement currently emits no lock hash; keep that explicit
    // in the compared identity set instead of silently dropping the field.
    lockHash: response.plan.artifacts.lockHash ?? null,
    bundleIdentity: response.plan.artifacts.bundleIdentity,
  }
}

function projectOverlayTemplate(): string {
  return `schema_version = 2
mode = "replace"

[[prompt]]
name = "project-overlay-first"
type = "inline"
content = "project-overlay-first"

[[prompt]]
name = "dynamic-success"
type = "exec"
command = "printf 'dynamic-success=%s:%s' \\"$PWD\\" \\"$PINNED_PARITY_VALUE\\""

[[prompt]]
name = "dynamic-failure"
type = "exec"
command = "printf 'FAILED-EXEC-LEAK'; printf 'pinned failure' >&2; exit 23"

[[prompt]]
name = "predicate-skipped"
type = "inline"
content = "PREDICATE-SKIP-LEAK"
when = { runMode = "heartbeat" }

[[prompt]]
name = "project-overlay-last"
type = "inline"
content = "project-overlay-last"
`
}

function canonicalShadowTemplate(): string {
  return `schema_version = 2
mode = "replace"

[[prompt]]
name = "canonical-shadow"
type = "inline"
content = "CANONICAL-SHADOW-LEAK"
`
}
