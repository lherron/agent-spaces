import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentInspectionDiagnostic,
  AgentInspectionEvaluationContext,
  AgentInspectionPart,
  AgentInspectionRequest,
  AgentInspectionResult,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import * as AgentSpaces from '../index.js'

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

type DryRunAgentProjection = {
  accepted: boolean
  promptBytes: string
  sectionOrder: string[]
  capabilities: AgentInspectionPart[]
  runtimeSettings: AgentInspectionPart[]
  diagnostics: AgentInspectionDiagnostic[]
  identity: StableCompileIdentity
}

type ProjectAgentCompileForDryRun = (input: {
  response: RuntimeCompileResponse
  inspection: AgentInspectionResult
}) => DryRunAgentProjection

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
    `schema = 1
agents-root = "agents"

[targets.${AGENT_ID}]
compose = []
`
  )
  await writeFile(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2

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

describe('T-06331 contextual inspection parity with dry-run', () => {
  test('projects the five-leg pinned fixture identically for inspection and dry-run', async () => {
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

    const project = projector()({
      response: compiled.response,
      inspection: compiled.inspection,
    })
    expect(project.promptBytes).toBe(expectedPrompt)
    expect(project.sectionOrder).toEqual(promptParts.map((part) => part.partId))
    expect(project.capabilities).toEqual(
      compiled.inspection.parts.filter((part) => part.kind === 'capability')
    )
    expect(project.runtimeSettings).toEqual(
      compiled.inspection.parts.filter((part) => part.kind === 'runtime-setting')
    )
    expect(project.diagnostics).toEqual(compiled.inspection.diagnostics)
    expect(project.identity).toEqual(stableIdentity(compiled.response, compiled.inspection))
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

  test('refuses the partial dry-run projection while inspection preserves it from one compile', async () => {
    const compiled = await compilePinnedFixture()
    const beforeProjection = compiled.compileCount
    const project = projector()({
      response: compiled.response,
      inspection: compiled.inspection,
    })

    expect(compiled.compileCount, 'projection must not invoke the compiler again').toBe(
      beforeProjection
    )
    expect(compiled.response.ok).toBe(true)
    expect(compiled.inspection.completeness.kind).toBe('partial')
    expect(project.accepted).toBe(false)
    expect(project.diagnostics).toEqual(compiled.inspection.diagnostics)
    expect(project.diagnostics).toContainEqual(
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
  const client = AgentSpaces.createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
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

function projector(): ProjectAgentCompileForDryRun {
  const operation = (AgentSpaces as Record<string, unknown>)['projectAgentCompileForDryRun']
  expect(
    operation,
    'agent-spaces must export the additive projector consumed by dry-run; it must not compile'
  ).toBeFunction()
  return operation as ProjectAgentCompileForDryRun
}

function inspectionRequest(): AgentInspectionRequest {
  return {
    schemaVersion: 'agent-inspection-request/v1',
    identifiers: identifiers(),
    declaredOverrides: { modelId: 'gpt-5.5', reasoningEffort: 'medium' },
  }
}

function evaluationContext(): AgentInspectionEvaluationContext {
  return {
    schemaVersion: 'agent-inspection-evaluation-context/v1',
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

function identifiers() {
  return {
    agentId: AGENT_ID,
    agentName: 'Parity Agent',
    projectId: 'parity-project',
    mode: 'task',
    scope: `agent:${AGENT_ID}:project:parity-project:task:T-06331`,
    taskId: 'T-06331',
    lane: 'main',
    harness: 'codex',
    frontend: 'taskboard',
    interaction: 'headless',
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
