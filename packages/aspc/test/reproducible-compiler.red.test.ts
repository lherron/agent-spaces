/**
 * T-04133 RED: ASPC must behave like a reproducible compiler.
 *
 * These acceptance tests exercise the public stdio facade and CLI surfaces. They
 * intentionally avoid private compiler internals so the implementer can change
 * the mechanics while preserving the externally observable contract.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BrokerExecutionProfile, RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../../agent-spaces/src/testing/pre-hrc-broker-helpers.js'
import { AspcClient } from '../src/index.js'

type Fixture = {
  base: string
  agentRoot: string
  projectRoot: string
  aspHome: string
  codexPath: string
}

const repoRoot = new URL('../../..', import.meta.url).pathname
const fixedCompileContext = {
  nowIso: '2026-06-22T00:00:00.000Z',
  idSalt: 'T-04133-red',
  toolchainManifest: {
    schemaVersion: 'compile-toolchain-manifest/v1',
    tools: [{ name: 'codex', version: '999.0.0' }],
    modelCatalog: { openai: { default: 'gpt-5' } },
  },
}

const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
const INHERITED_BROKER_ENV_PREFIXES = ['HARNESS_BROKER_']

let fixture: Fixture

beforeEach(() => {
  fixture = createFixture()
  process.env['ASP_CODEX_PATH'] = fixture.codexPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
})

afterEach(() => {
  restoreEnv('ASP_CODEX_PATH', originalCodexPath)
  restoreEnv('ASP_CODEX_SKIP_COMMON_PATHS', originalSkipCommon)
  rmSync(fixture.base, { recursive: true, force: true })
})

describe('T-04133 red: reproducible ASPC compiler surfaces', () => {
  test('stdio compileRuntimePlan accepts fixed compile context and derives omitted initial input ids deterministically', async () => {
    const client = await startFacadeClient()
    try {
      const firstRequest = buildCompileRequest('fixed_context')
      const secondRequest = buildCompileRequest('fixed_context')
      const generationChanged = buildCompileRequest('fixed_context', { generation: 2 })

      const first = await client.request('aspc.compileRuntimePlan', {
        compileRequest: firstRequest,
        aspHome: fixture.aspHome,
        compileContext: fixedCompileContext,
      })
      const second = await client.request('aspc.compileRuntimePlan', {
        compileRequest: secondRequest,
        aspHome: fixture.aspHome,
        compileContext: fixedCompileContext,
      })
      const changed = await client.request('aspc.compileRuntimePlan', {
        compileRequest: generationChanged,
        aspHome: fixture.aspHome,
        compileContext: fixedCompileContext,
      })

      const firstPlan = expectOkPlan(first)
      const secondPlan = expectOkPlan(second)
      const changedPlan = expectOkPlan(changed)
      const firstProfile = brokerProfile(firstPlan)
      const secondProfile = brokerProfile(secondPlan)
      const changedProfile = brokerProfile(changedPlan)

      expect(firstPlan.createdAt).toBe(fixedCompileContext.nowIso)
      expect(secondPlan.createdAt).toBe(fixedCompileContext.nowIso)
      expect(secondPlan.compileId).toBe(firstPlan.compileId)
      expect(secondPlan.planHash).toBe(firstPlan.planHash)
      expect(secondProfile.profileHash).toBe(firstProfile.profileHash)
      expect(secondProfile.harnessInvocation.initialInputHash).toBe(
        firstProfile.harnessInvocation.initialInputHash
      )
      expect(secondProfile.harnessInvocation.startRequestHash).toBe(
        firstProfile.harnessInvocation.startRequestHash
      )
      expect(secondProfile.harnessInvocation.startRequest.initialInput?.inputId).toBe(
        firstProfile.harnessInvocation.startRequest.initialInput?.inputId
      )

      // Negative guard: the derived id is scoped to identity/generation/content,
      // so a later generation must not be deduped against the earlier request.
      expect(changedProfile.harnessInvocation.startRequest.initialInput?.inputId).not.toBe(
        firstProfile.harnessInvocation.startRequest.initialInput?.inputId
      )
      expect(changedProfile.harnessInvocation.startRequestHash).not.toBe(
        firstProfile.harnessInvocation.startRequestHash
      )
    } finally {
      await client.close()
    }
  })

  test('aspc manifest emits byte-stable canonical JSON with a complete output manifest without starting a harness', () => {
    const requestPath = writeRequestFixture('manifest_stability')
    const firstHome = join(fixture.base, 'manifest-home-a')
    const secondHome = join(fixture.base, 'manifest-home-b')
    mkdirSync(firstHome, { recursive: true })
    mkdirSync(secondHome, { recursive: true })

    const first = runAspcCli([
      'manifest',
      '--request',
      requestPath,
      '--asp-home',
      firstHome,
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ])
    const second = runAspcCli([
      'manifest',
      '--request',
      requestPath,
      '--asp-home',
      secondHome,
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ])

    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toBe(first.stdout)

    const manifest = JSON.parse(first.stdout) as {
      outputManifestHash?: unknown
      entries?: Array<{ path?: unknown; sha256?: unknown; mode?: unknown; mtime?: unknown }>
      startedHarness?: unknown
    }
    expect(manifest.outputManifestHash).toEqual(expect.any(String))
    expect(manifest.entries?.length).toBeGreaterThan(0)
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.any(String),
          sha256: expect.any(String),
          mode: expect.any(String),
        }),
      ])
    )
    expect(JSON.stringify(manifest)).not.toContain(fixture.base)
    expect(JSON.stringify(manifest)).not.toContain(process.env['HOME'] ?? '__no_home__')
    expect(manifest.entries?.some((entry) => 'mtime' in entry)).toBe(false)
    expect(manifest.startedHarness).not.toBe(true)
  })

  test('aspc verify-release reports byte-identical builds and classifies deterministic mechanics/content changes', () => {
    const corpusRoot = writeGoldCorpusFixture()

    const identical = runAspcCli([
      'verify-release',
      '--baseline',
      aspcCliPath(),
      '--candidate',
      aspcCliPath(),
      '--corpus',
      corpusRoot,
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ])
    expect(identical.status, identical.stderr).toBe(0)
    expect(JSON.parse(identical.stdout)).toMatchObject({
      verdict: 'byte-identical',
      differences: [],
    })

    const changedCatalog = runAspcCli([
      'verify-release',
      '--baseline',
      aspcCliPath(),
      '--candidate',
      aspcCliPath(),
      '--corpus',
      join(corpusRoot, 'mechanics-model-bump'),
      '--compile-context',
      JSON.stringify({
        ...fixedCompileContext,
        toolchainManifest: {
          ...fixedCompileContext.toolchainManifest,
          modelCatalog: { openai: { default: 'gpt-5.1' } },
        },
      }),
    ])
    expect(changedCatalog.status).not.toBe(0)
    expect(JSON.parse(changedCatalog.stdout)).toMatchObject({
      verdict: 'deterministic-diff',
      differences: [expect.objectContaining({ class: 'mechanics', attribution: 'modelCatalog' })],
    })

    const changedPrompt = runAspcCli([
      'verify-release',
      '--baseline',
      aspcCliPath(),
      '--candidate',
      aspcCliPath(),
      '--corpus',
      join(corpusRoot, 'content-prompt-change'),
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ])
    expect(changedPrompt.status).not.toBe(0)
    expect(JSON.parse(changedPrompt.stdout)).toMatchObject({
      verdict: 'deterministic-diff',
      differences: [expect.objectContaining({ class: 'content', attribution: 'prompt' })],
    })
  })
})

function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'aspc-reproducible-compiler-red-'))
  const agentRoot = join(base, 'agents', 'sparky')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2

[spaces]
base = []
`,
    'utf8'
  )
  return {
    base,
    agentRoot,
    projectRoot,
    aspHome,
    codexPath: createCodexShim(aspHome),
  }
}

function createCodexShim(dir: string): string {
  const shimPath = join(dir, 'codex')
  const fixturePath = new URL(
    '../../harness-broker/test/fixtures/fake-codex/start-fresh-turn.ts',
    import.meta.url
  ).pathname
  writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
if [[ "$*" == *"--version"* ]]; then
  echo "codex 999.0.0"
  exit 0
fi
if [[ "$*" == *"app-server"* && "$*" == *"--help"* ]]; then
  echo "app-server"
  exit 0
fi
if [[ "$*" == *"app-server"* ]]; then
  exec bun "${fixturePath}"
fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(shimPath, 0o755)
  return shimPath
}

function buildCompileRequest(
  namespace: string,
  overrides: { generation?: number | undefined; initialPrompt?: string | undefined } = {}
): RuntimeCompileRequest {
  const generation = overrides.generation ?? 1
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: `aspc_repro_${namespace}`,
    generation,
    invocationId: `inv_aspc_repro_${namespace}_${generation}`,
    withInitialInput: false,
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: 'sparky@agent-spaces',
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    hostSessionId: identity.hostSessionId,
  })
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: overrides.initialPrompt ?? `Say ${namespace}`,
      taskContext: {
        taskId: 'T-04133',
        phase: 'red-acceptance',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 10_000 },
      observability: { traceId: identity.traceId },
      capabilityPolicy: { allowDegrade: false, requireBrokerDefaultForCodexHeadless: true },
    },
    correlation: {
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      runtimeId: identity.runtimeId,
      runId: identity.runId,
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      appId: 'agent-spaces',
      appSessionKey: `aspc-repro-${namespace}`,
      scopeRef: 'sparky@agent-spaces',
      laneRef: 'main',
    },
  }
}

function expectOkPlan(value: unknown) {
  expect(value).toMatchObject({ ok: true })
  const response = value as {
    ok: true
    plan: {
      createdAt: string
      compileId: string
      planHash: string
      executionProfiles: unknown[]
    }
  }
  return response.plan
}

function brokerProfile(plan: ReturnType<typeof expectOkPlan>): BrokerExecutionProfile {
  const profiles = plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile =>
      typeof profile === 'object' &&
      profile !== null &&
      (profile as { kind?: unknown }).kind === 'harness-broker'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

async function startFacadeClient(): Promise<AspcClient> {
  return AspcClient.start({
    command: process.execPath,
    args: ['packages/aspc/bin/aspc-facade.js', 'run', '--transport', 'stdio'],
    cwd: repoRoot,
    env: brokerEnvOverrides({
      ASP_CODEX_PATH: fixture.codexPath,
      ASP_CODEX_SKIP_COMMON_PATHS: '1',
    }),
  })
}

function writeRequestFixture(namespace: string): string {
  const requestPath = join(fixture.base, `${namespace}-request.json`)
  writeFileSync(requestPath, `${JSON.stringify(buildCompileRequest(namespace), null, 2)}\n`, 'utf8')
  return requestPath
}

function writeGoldCorpusFixture(): string {
  const corpusRoot = join(fixture.base, 'gold-corpus')
  const identicalCase = join(corpusRoot, 'byte-identical')
  const mechanicsCase = join(corpusRoot, 'mechanics-model-bump')
  const contentCase = join(corpusRoot, 'content-prompt-change')
  for (const dir of [identicalCase, mechanicsCase, contentCase]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(
    join(identicalCase, 'request.json'),
    `${JSON.stringify(buildCompileRequest('byte_identical'), null, 2)}\n`,
    'utf8'
  )
  writeFileSync(
    join(mechanicsCase, 'request.json'),
    `${JSON.stringify(buildCompileRequest('mechanics_model_bump'), null, 2)}\n`,
    'utf8'
  )
  writeFileSync(
    join(contentCase, 'request.json'),
    `${JSON.stringify(
      buildCompileRequest('content_prompt_change', {
        initialPrompt: 'Changed deterministic prompt',
      }),
      null,
      2
    )}\n`,
    'utf8'
  )
  return corpusRoot
}

function runAspcCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [aspcCliPath(), ...args], {
    cwd: repoRoot,
    env: brokerProcessEnv({
      ASP_CODEX_PATH: fixture.codexPath,
      ASP_CODEX_SKIP_COMMON_PATHS: '1',
    }),
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function aspcCliPath(): string {
  return join(repoRoot, 'packages/aspc/bin/aspc.js')
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function brokerEnvOverrides(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...overrides }
  for (const key of Object.keys(process.env)) {
    if (INHERITED_BROKER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = undefined
    }
  }
  return env
}

function brokerProcessEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (INHERITED_BROKER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }
  return env
}
