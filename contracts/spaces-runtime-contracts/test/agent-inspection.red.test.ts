import { describe, expect, test } from 'bun:test'
import * as Contracts from '../src/index'

type ValidationIssue = {
  path: string
  code: string
  message: string
}

type ContractValidator = (value: unknown) => unknown

function contractValidator(
  name:
    | 'validateAgentInspectionResult'
    | 'validateAgentInspectionRequest'
    | 'validateAgentInspectionEvaluationContext'
) {
  const validator = (Contracts as Record<string, unknown>)[name]
  expect(validator, `${name} must be barrel-exported`).toBeFunction()
  return validator as ContractValidator
}

function validationIssues(run: () => unknown): ValidationIssue[] {
  try {
    run()
  } catch (error) {
    const issues = (error as { issues?: unknown }).issues
    expect(Array.isArray(issues), 'contract validation errors must expose accumulated issues').toBe(
      true
    )
    return issues as ValidationIssue[]
  }
  throw new Error('Expected contract validation to reject the value')
}

const provenance = {
  contributions: [
    {
      kind: 'agent',
      sourceId: 'room-tester',
      sourceRef: 'agent://room-tester/agent.toml',
    },
  ],
}

function part(
  partId: string,
  kind: string,
  value: Record<string, unknown>,
  disposition: Record<string, unknown> = { kind: 'effective' }
) {
  return { partId, kind, disposition, provenance, value }
}

function inspectionResult() {
  return {
    schemaVersion: 'agent-inspection/v1',
    identity: {
      agentId: 'room-tester',
      projectId: 'agent-spaces',
      mode: 'task',
      scope: 'room-tester@agent-spaces:T-06328',
      taskId: 'T-06328',
      lane: 'main',
      harness: 'codex',
      frontend: 'taskboard',
      interaction: 'headless',
    },
    parts: [
      part('prompt:prompt:soul', 'prompt', {
        zone: 'prompt',
        name: 'soul',
        sourceType: 'file',
        order: 0,
        content: 'You are room-tester.',
      }),
      part('capability:tools.exec', 'capability', {
        capabilityId: 'tools.exec',
        enabled: true,
      }),
      part('runtime-setting:permissions', 'runtime-setting', {
        settingId: 'permissions',
        value: { mode: 'workspace-write' },
      }),
      part('harness:selected', 'harness', {
        family: 'codex',
        runtime: 'codex-cli',
        provider: 'openai',
      }),
      part('model:selected', 'model', {
        provider: 'openai',
        modelId: 'gpt-5',
      }),
      part('execution-profile:headless', 'execution-profile', {
        profileId: 'headless',
        controllerKind: 'harness-broker',
      }),
      part('artifact:compiled-bundle', 'artifact', {
        artifactKind: 'bundle',
        bundleIdentity: 'bundle-1',
      }),
    ],
    completeness: { kind: 'complete' },
    freshness: {
      kind: 'fresh',
      evaluatedAt: '2026-07-18T12:00:00.000Z',
      compileId: 'compile-1',
      planHash: 'plan-1',
      lockHash: 'lock-1',
      bundleIdentity: 'bundle-1',
      contextHash: 'context-1',
    },
    diagnostics: [
      {
        kind: 'compile',
        severity: 'info',
        code: 'compile.ok',
        message: 'Runtime plan compiled',
      },
      {
        kind: 'resolution',
        severity: 'warning',
        code: 'context.optional_empty',
        message: 'Optional context was empty',
        partId: 'prompt:prompt:soul',
      },
      {
        kind: 'validation',
        severity: 'error',
        code: 'inspection.invalid_part',
        message: 'Example validation diagnostic',
        path: 'parts.0',
      },
    ],
  }
}

describe('agent-inspection/v1 contract', () => {
  test('accepts every viewer part and discriminated disposition/diagnostic/freshness arm', () => {
    const validate = contractValidator('validateAgentInspectionResult')
    const dispositionArms = [
      { kind: 'effective' },
      { kind: 'overridden', byPartId: 'runtime-setting:model' },
      { kind: 'deduplicated', canonicalPartId: 'prompt:prompt:soul' },
      { kind: 'skipped', reason: 'predicate' },
      { kind: 'skipped', reason: 'empty' },
      {
        kind: 'failed',
        source: { kind: 'exec', command: 'inspect-agent' },
        reason: 'command exited 1',
      },
    ]
    const freshnessArms = [
      inspectionResult().freshness,
      {
        kind: 'stale',
        evaluatedAt: '2026-07-18T12:00:00.000Z',
        reason: 'lock-changed',
        expectedLockHash: 'lock-2',
        actualLockHash: 'lock-1',
      },
      { kind: 'unknown', reason: 'compile-identity-unavailable' },
    ]
    const completenessArms = [
      { kind: 'complete' },
      { kind: 'partial', missingPartIds: ['capability:tools.exec'] },
    ]

    for (const disposition of dispositionArms) {
      const candidate = inspectionResult()
      candidate.parts[0] = part(
        'prompt:prompt:soul',
        'prompt',
        candidate.parts[0]?.value ?? {},
        disposition
      )
      expect(validate(candidate)).toBe(candidate)
    }
    for (const freshness of freshnessArms) {
      const candidate = { ...inspectionResult(), freshness }
      expect(validate(candidate)).toBe(candidate)
    }
    for (const completeness of completenessArms) {
      const candidate = { ...inspectionResult(), completeness }
      expect(validate(candidate)).toBe(candidate)
    }
  })

  test('rejects unknown schema and union arms with accumulated path diagnostics', () => {
    const validate = contractValidator('validateAgentInspectionResult')
    const candidate = inspectionResult()
    candidate.schemaVersion = 'agent-inspection/v2'
    candidate.parts[0] = part('prompt:prompt:soul', 'mystery', {}, { kind: 'invented' })
    candidate.completeness = { kind: 'maybe' }
    candidate.freshness = { kind: 'ancient' } as typeof candidate.freshness
    candidate.diagnostics[0] = {
      ...candidate.diagnostics[0],
      kind: 'mystery',
    }

    const paths = validationIssues(() => validate(candidate)).map((issue) => issue.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'schemaVersion',
        'parts.0.kind',
        'parts.0.disposition.kind',
        'completeness.kind',
        'freshness.kind',
        'diagnostics.0.kind',
      ])
    )
  })
})

describe('agent inspection consumer boundary', () => {
  test('requires a fully explicit validated evaluation context', () => {
    const validate = contractValidator('validateAgentInspectionEvaluationContext')
    const context = {
      schemaVersion: 'agent-inspection-evaluation-context/v1',
      identifiers: {
        agentId: 'room-tester',
        projectId: 'agent-spaces',
        mode: 'task',
        scope: 'room-tester@agent-spaces:T-06328',
        taskId: 'T-06328',
        lane: 'main',
        harness: 'codex',
        frontend: 'taskboard',
        interaction: 'headless',
      },
      paths: {
        agentRoot: '/asp/agents/room-tester',
        agentsRoot: '/asp/agents',
        projectRoot: '/asp/projects/agent-spaces',
        cwd: '/asp/projects/agent-spaces',
      },
      nowIso: '2026-07-18T12:34:56.000Z',
      environment: { INSPECTION_MODE: '1' },
      predicateInputs: {
        cwd: '/asp/projects/agent-spaces',
        environment: { INSPECTION_MODE: '1' },
      },
      execInputs: { cwd: '/asp/agents/room-tester', environment: {} },
      serviceProbeInputs: { responses: [] },
      scaffoldPackets: [],
      agentProfile: {},
      declaredOverrides: { modelId: 'gpt-5' },
      compileContext: {
        nowIso: '2026-07-18T12:34:56.000Z',
        idSalt: 'inspection-t06328',
        toolchainManifest: { schemaVersion: 'compile-toolchain/v1' },
      },
    }

    expect(validate(context)).toBe(context)
    const issues = validationIssues(() =>
      validate({ schemaVersion: context.schemaVersion, identifiers: context.identifiers })
    )
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'paths',
        'nowIso',
        'environment',
        'predicateInputs',
        'execInputs',
        'serviceProbeInputs',
        'compileContext',
      ])
    )
  })

  test('rejects raw paths, raw environment maps, and credential-shaped inputs', () => {
    const validate = contractValidator('validateAgentInspectionRequest')
    const request = {
      schemaVersion: 'agent-inspection-request/v1',
      identifiers: {
        agentId: 'room-tester',
        projectId: 'agent-spaces',
        mode: 'task',
        scope: 'room-tester@agent-spaces:T-06328',
        taskId: 'T-06328',
        lane: 'main',
        harness: 'codex',
        frontend: 'taskboard',
        interaction: 'headless',
      },
      declaredOverrides: {
        modelId: 'gpt-5',
        workingDirectory: '/callers/private/checkout',
        environment: { SAFE_LOOKING_KEY: 'caller-value' },
        apiKey: 'secret',
      },
      cwd: '/callers/private/checkout',
      agentRoot: '/callers/private/agent',
      projectRoot: '/callers/private/project',
      env: { OPENAI_API_KEY: 'secret' },
      credentials: { bearerToken: 'secret' },
    }

    const issues = validationIssues(() => validate(request))
    const paths = issues.map((issue) => issue.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'cwd',
        'agentRoot',
        'projectRoot',
        'env',
        'credentials',
        'declaredOverrides.workingDirectory',
        'declaredOverrides.environment',
        'declaredOverrides.apiKey',
      ])
    )
  })
})
