import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentInspectionEvaluationContext,
  AgentInspectionRequest,
  AgentInspectionResult,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { validateAgentInspectionResult } from 'spaces-runtime-contracts'
import * as AgentSpaces from '../index.js'

type CompileRuntimePlan = (
  request: unknown,
  options?: Record<string, unknown>
) => Promise<RuntimeCompileResponse>

type InspectionOutcome =
  | { ok: true; inspection: AgentInspectionResult }
  | {
      ok: false
      diagnostics: Array<{ severity?: string; level?: string; code: string; message: string }>
    }

type CatalogRow = {
  agentId: string
  diagnostics: Array<{ severity?: string; level?: string; code: string; message: string }>
  warningCount: number
  errorCount: number
}

type CatalogResult = { agents: CatalogRow[] }

type InspectAgentForContext = (
  input: { request: unknown; evaluationContext: unknown },
  options?: { compileRuntimePlan?: CompileRuntimePlan | undefined }
) => Promise<InspectionOutcome>

type CatalogAgentsForContext = (input: {
  evaluationContext: unknown
}) => Promise<CatalogResult>

type Fixture = {
  root: string
  agentsRoot: string
  validRoot: string
  brokenRoot: string
  projectRoot: string
  ambientA: string
  ambientB: string
}

let fixture: Fixture
let originalCwd: string
const AMBIENT_KEY = 'ASP_T06330_AMBIENT_ONLY'
let originalAmbient: string | undefined

beforeEach(async () => {
  originalCwd = process.cwd()
  originalAmbient = process.env[AMBIENT_KEY]
  const root = await mkdtemp(join(tmpdir(), 'agent-inspection-operations-'))
  const agentsRoot = join(root, 'agents')
  const validRoot = join(agentsRoot, 'valid-agent')
  const brokenRoot = join(agentsRoot, 'broken-agent')
  const projectRoot = join(root, 'project')
  const ambientA = join(root, 'ambient-a')
  const ambientB = join(root, 'ambient-b')
  for (const path of [validRoot, brokenRoot, projectRoot, ambientA, ambientB]) {
    await mkdir(path, { recursive: true })
  }
  await writeFile(
    join(validRoot, 'agent-profile.toml'),
    'schemaVersion = 2\n\n[spaces]\nbase = []\n\n[instructions]\ntemplate = "context-template.toml"\n'
  )
  await writeFile(join(validRoot, 'SOUL.md'), 'valid agent soul\n')
  await writeFile(join(brokenRoot, 'agent-profile.toml'), 'schemaVersion = [ definitely invalid')
  await writeFile(join(brokenRoot, 'SOUL.md'), 'broken agent partial soul\n')
  fixture = { root, agentsRoot, validRoot, brokenRoot, projectRoot, ambientA, ambientB }
})

afterEach(async () => {
  process.chdir(originalCwd)
  if (originalAmbient === undefined) {
    delete process.env[AMBIENT_KEY]
  } else {
    process.env[AMBIENT_KEY] = originalAmbient
  }
  await rm(fixture.root, { recursive: true, force: true })
})

describe('T-06330 agent catalog and contextual inspection operations', () => {
  test('performs one canonical compile and exposes that producer to both CLI and wire surfaces', async () => {
    const { inspectAgentForContext } = operations()
    await writeFile(
      join(fixture.validRoot, 'context-template.toml'),
      inlineTemplate('stable prompt')
    )
    let compileCount = 0
    const compileRuntimePlan: CompileRuntimePlan = async () => {
      compileCount += 1
      return successfulCompileResponse()
    }

    const outcome = await inspectAgentForContext(
      { request: inspectionRequest(), evaluationContext: evaluationContext() },
      { compileRuntimePlan }
    )

    expect(outcome.ok).toBe(true)
    expect(compileCount, 'one inspection must invoke the canonical compiler exactly once').toBe(1)
    if (!outcome.ok) return
    expect(validateAgentInspectionResult(outcome.inspection)).toBe(outcome.inspection)
    expect(new Set(outcome.inspection.parts.map((part) => part.kind))).toEqual(
      new Set([
        'prompt',
        'capability',
        'runtime-setting',
        'harness',
        'model',
        'execution-profile',
        'artifact',
      ])
    )

    const [cliSources, wireSources] = await Promise.all([
      readTypeScriptTree(new URL('../../../cli/src', import.meta.url)),
      readTypeScriptTree(new URL('../../../aspc/src', import.meta.url)),
    ])
    for (const [surface, sources] of [
      ['CLI', cliSources],
      ['ASPC wire', wireSources],
    ] as const) {
      expect(
        sources.includes('inspectAgentForContext'),
        `${surface} must delegate inspection to the agent-spaces producer assembly`
      ).toBe(true)
      expect(
        sources.includes('catalogAgentsForContext'),
        `${surface} must delegate catalog reads to the agent-spaces producer assembly`
      ).toBe(true)
    }
  })

  test('keeps invalid agents in the catalog with counts and returns a diagnostic inspection failure while valid agents remain inspectable', async () => {
    const { catalogAgentsForContext, inspectAgentForContext } = operations()
    await writeFile(
      join(fixture.validRoot, 'context-template.toml'),
      inlineTemplate('valid prompt')
    )

    const catalog = await catalogAgentsForContext({ evaluationContext: evaluationContext() })
    const broken = catalog.agents.find((agent) => agent.agentId === 'broken-agent')
    expect(broken, 'catalog must not omit an invalid agent profile').toBeDefined()
    expect(broken?.diagnostics.length).toBeGreaterThan(0)
    expect((broken?.warningCount ?? 0) + (broken?.errorCount ?? 0)).toBeGreaterThan(0)

    const invalidOutcome = await inspectAgentForContext(
      {
        request: inspectionRequest('broken-agent'),
        evaluationContext: evaluationContext('broken-agent'),
      },
      { compileRuntimePlan: async () => failedCompileResponse() }
    )
    expect(invalidOutcome.ok).toBe(false)
    if (!invalidOutcome.ok) {
      expect(invalidOutcome.diagnostics.length).toBeGreaterThan(0)
      expect(invalidOutcome.diagnostics.some((diagnostic) => diagnostic.message.length > 0)).toBe(
        true
      )
    }

    const validOutcome = await inspectAgentForContext(
      { request: inspectionRequest(), evaluationContext: evaluationContext() },
      { compileRuntimePlan: async () => successfulCompileResponse() }
    )
    expect(validOutcome.ok).toBe(true)
    if (validOutcome.ok) validateAgentInspectionResult(validOutcome.inspection)
  })

  test('is invariant to caller cwd and ambient env when the explicit evaluation context is fixed', async () => {
    const { inspectAgentForContext } = operations()
    await writeFile(join(fixture.projectRoot, 'inspection-enabled.flag'), 'enabled\n')
    await writeFile(
      join(fixture.validRoot, 'context-template.toml'),
      `schema_version = 2
mode = "replace"

[[prompt]]
name = "explicit"
type = "inline"
content = "pinned={{env.PINNED_INSPECTION_VALUE}} date={{dateUtc}}"
when = { exists = "inspection-enabled.flag" }

[[prompt]]
name = "exec-cwd"
type = "exec"
command = "printf '%s' \\"$PWD\\""
`
    )
    const context = evaluationContext()
    const request = inspectionRequest()
    const inspectUnderAmbient = async (cwd: string, value: string) => {
      process.chdir(cwd)
      process.env[AMBIENT_KEY] = value
      return inspectAgentForContext(
        { request, evaluationContext: context },
        { compileRuntimePlan: async () => successfulCompileResponse() }
      )
    }

    const first = await inspectUnderAmbient(fixture.ambientA, 'first-ambient')
    const second = await inspectUnderAmbient(fixture.ambientB, 'second-ambient')

    expect(first).toEqual(second)
    expect(JSON.stringify(first)).toContain('explicit-value')
    expect(JSON.stringify(first)).toContain(fixture.validRoot)
    expect(JSON.stringify(first)).not.toContain('first-ambient')
    expect(JSON.stringify(first)).not.toContain('second-ambient')
  })

  test('flows a failed exec section into a partial result without compiling failed stdout bytes', async () => {
    const { inspectAgentForContext } = operations()
    await writeFile(
      join(fixture.validRoot, 'context-template.toml'),
      `schema_version = 2
mode = "replace"

[[prompt]]
name = "stable"
type = "inline"
content = "stable prompt"

[[prompt]]
name = "failed-exec"
type = "exec"
command = "printf 'FAILED-EXEC-LEAK'; printf 'exec-stderr' >&2; exit 23"
`
    )

    const outcome = await inspectAgentForContext(
      { request: inspectionRequest(), evaluationContext: evaluationContext() },
      { compileRuntimePlan: async () => successfulCompileResponse() }
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const inspection = validateAgentInspectionResult(outcome.inspection)
    expect(inspection.completeness.kind).toBe('partial')
    if (inspection.completeness.kind === 'partial') {
      expect(inspection.completeness.missingPartIds).toContain('prompt:prompt:failed-exec')
    }
    const failed = inspection.parts.find(
      (part) => part.kind === 'prompt' && part.partId === 'prompt:prompt:failed-exec'
    )
    expect(failed?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'exec' },
    })
    if (failed?.disposition.kind === 'failed') {
      expect(failed.disposition.reason).toMatch(/exit[ -]?code/i)
      expect(failed.disposition.reason).toContain('23')
    }
    const promptBytes = inspection.parts
      .filter((part) => part.kind === 'prompt')
      .map((part) => (part.kind === 'prompt' ? (part.value.content ?? '') : ''))
      .join('\n')
    expect(promptBytes).toContain('stable prompt')
    expect(promptBytes).not.toContain('FAILED-EXEC-LEAK')
  })
})

function operations(): {
  inspectAgentForContext: InspectAgentForContext
  catalogAgentsForContext: CatalogAgentsForContext
} {
  const exports = AgentSpaces as Record<string, unknown>
  expect(
    exports['inspectAgentForContext'],
    'agent-spaces must export inspectAgentForContext as the canonical producer assembly'
  ).toBeFunction()
  expect(
    exports['catalogAgentsForContext'],
    'agent-spaces must export catalogAgentsForContext as the canonical catalog operation'
  ).toBeFunction()
  return {
    inspectAgentForContext: exports['inspectAgentForContext'] as InspectAgentForContext,
    catalogAgentsForContext: exports['catalogAgentsForContext'] as CatalogAgentsForContext,
  }
}

function inspectionRequest(agentId = 'valid-agent'): AgentInspectionRequest {
  return {
    schemaVersion: 'agent-inspection-request/v1',
    identifiers: identity(agentId),
    declaredOverrides: { modelId: 'gpt-5', reasoningEffort: 'medium' },
  }
}

function evaluationContext(agentId = 'valid-agent'): AgentInspectionEvaluationContext {
  const agentRoot = agentId === 'broken-agent' ? fixture.brokenRoot : fixture.validRoot
  return {
    schemaVersion: 'agent-inspection-evaluation-context/v1',
    identifiers: identity(agentId),
    paths: {
      agentRoot,
      agentsRoot: fixture.agentsRoot,
      projectRoot: fixture.projectRoot,
      cwd: fixture.projectRoot,
    },
    nowIso: '2026-07-18T12:34:56.000Z',
    environment: { PINNED_INSPECTION_VALUE: 'explicit-value' },
    predicateInputs: { cwd: fixture.projectRoot, environment: {} },
    execInputs: { cwd: agentRoot, environment: {} },
    serviceProbeInputs: { responses: [] },
    scaffoldPackets: [],
    agentProfile: {},
    declaredOverrides: { modelId: 'gpt-5', reasoningEffort: 'medium' },
    compileContext: {
      nowIso: '2026-07-18T12:34:56.000Z',
      idSalt: 'inspection-t06330',
      toolchainManifest: {
        schemaVersion: 'compile-toolchain/v1',
        tools: [{ name: 'agent-spaces', version: 'test' }],
      },
    },
  }
}

function identity(agentId: string) {
  return {
    agentId,
    agentName: agentId === 'valid-agent' ? 'Valid Agent' : 'Broken Agent',
    projectId: 'agent-spaces',
    mode: 'task',
    scope: `${agentId}@agent-spaces:T-06330`,
    taskId: 'T-06330',
    lane: 'main',
    harness: 'codex',
    frontend: 'taskboard',
    interaction: 'headless',
  }
}

function successfulCompileResponse(): RuntimeCompileResponse {
  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: true,
    plan: {
      schemaVersion: 'agent-runtime-plan/v1',
      compiler: { name: 'agent-spaces', version: 'test' },
      compileId: 'compile_t06330',
      planHash: 'plan_t06330',
      createdAt: '2026-07-18T12:34:56.000Z',
      identity: {} as never,
      placement: {} as never,
      resolvedBundle: { bundleIdentity: 'bundle_t06330' } as never,
      harness: { family: 'codex', runtime: 'codex-cli', provider: 'openai' },
      model: {
        provider: 'openai',
        modelId: 'gpt-5',
        requestedModel: 'gpt-5',
        reasoningEffort: 'medium',
      },
      executionProfiles: [
        {
          kind: 'terminal',
          profileId: 'profile_t06330',
          controllerKind: 'foreground-terminal',
        } as never,
      ],
      artifacts: {
        lockHash: 'lock_t06330',
        bundleIdentity: 'bundle_t06330',
      },
      lockedEnv: { lockedEnvKeys: [] },
      diagnostics: [],
    },
    diagnostics: [],
  }
}

function failedCompileResponse(): RuntimeCompileResponse {
  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: false,
    diagnostics: [
      {
        level: 'error',
        code: 'invalid_agent_profile',
        message: 'agent-profile.toml could not be parsed',
        plane: 'asp-compiler',
      },
    ],
  }
}

function inlineTemplate(content: string): string {
  return `schema_version = 2
mode = "replace"

[[prompt]]
name = "stable"
type = "inline"
content = "${content}"
`
}

async function readTypeScriptTree(root: URL): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true })
  const chunks = await Promise.all(
    entries.map(async (entry) => {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, root)
      if (entry.isDirectory()) return readTypeScriptTree(child)
      return entry.name.endsWith('.ts') ? readFile(child, 'utf8') : ''
    })
  )
  return chunks.join('\n')
}
