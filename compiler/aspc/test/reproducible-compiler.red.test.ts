/**
 * T-04133 RED: ASPC must behave like a reproducible compiler.
 *
 * These acceptance tests exercise the public stdio facade and CLI surfaces. They
 * intentionally avoid private compiler internals so the implementer can change
 * the mechanics while preserving the externally observable contract.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  BrokerExecutionProfile,
  OutputManifest,
  RuntimeCompileRequest,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../../agent-spaces/src/testing/pre-hrc-broker-helpers.js'
import { AspcClient } from '../src/index.js'
import { buildOutputManifest, canonicalJson } from '../src/manifest.js'
import type { verifyRelease } from '../src/verify-release.js'

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
      '--mode',
      'a',
      '--request',
      requestPath,
      '--asp-home',
      firstHome,
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ])
    const second = runAspcCli([
      'manifest',
      '--mode',
      'a',
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
      '--mode',
      'a',
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
      '--mode',
      'a',
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
      '--mode',
      'a',
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

describe('P0 red: verifier Mode A/B split', () => {
  test('AC1: mode is mandatory, recorded, and included in the output manifest hash', () => {
    type BuildInput = Parameters<typeof buildOutputManifest>[0]
    type VerifyInput = Parameters<typeof verifyRelease>[0]
    const buildModeIsRequired: BuildInput extends { mode: 'A' | 'B' } ? true : false = true
    const verifyModeIsRequired: VerifyInput extends { mode: 'A' | 'B' } ? true : false = true
    expect(buildModeIsRequired).toBe(true)
    expect(verifyModeIsRequired).toBe(true)

    const requestPath = writeRequestFixture('required_mode')
    const corpusRoot = writeGoldCorpusFixture()
    const manifestBase = [
      'manifest',
      '--request',
      requestPath,
      '--asp-home',
      fixture.aspHome,
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ]
    const verifyBase = [
      'verify-release',
      '--baseline',
      aspcCliPath(),
      '--candidate',
      aspcCliPath(),
      '--corpus',
      corpusRoot,
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ]

    for (const result of [
      runAspcCli(manifestBase),
      runAspcCli([...manifestBase, '--mode', 'A']),
      runAspcCli(verifyBase),
      runAspcCli([...verifyBase, '--mode', 'raw']),
    ]) {
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/usage|mode/i)
      expect(result.stdout).toBe('')
    }

    for (const [token, mode] of [
      ['a', 'A'],
      ['b', 'B'],
    ] as const) {
      const result = runAspcCli([...manifestBase, '--mode', token])
      expect(result.status, result.stderr).toBe(0)
      const manifest = JSON.parse(result.stdout) as OutputManifest
      expect(manifest.mode).toBe(mode)
      expect(manifest.outputManifestHash).toBe(
        sha256Hex(
          canonicalJson({
            mode,
            entries: manifest.entries,
            toolchainManifestHash: manifest.toolchainManifestHash,
          })
        )
      )
    }

    const report = runAspcCli([...verifyBase, '--mode', 'a'])
    expect(report.status, report.stderr).toBe(0)
    expect(JSON.parse(report.stdout)).toMatchObject({ mode: 'A' })
  })

  test('AC2: Mode A remains cross-home normalized self-stability evidence and cannot authorize cutover', () => {
    const requestPath = writeRequestFixture('mode_a_stability')
    const firstHome = join(fixture.base, 'mode-a-home-one')
    const secondHome = join(fixture.base, 'mode-a-home-two')
    mkdirSync(firstHome, { recursive: true })
    mkdirSync(secondHome, { recursive: true })

    const run = (aspHome: string) =>
      runAspcCli([
        'manifest',
        '--mode',
        'a',
        '--request',
        requestPath,
        '--asp-home',
        aspHome,
        '--compile-context',
        JSON.stringify(fixedCompileContext),
      ])
    const first = run(firstHome)
    const second = run(secondHome)
    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toBe(first.stdout)

    const report = runAspcCli([
      'verify-release',
      '--mode',
      'a',
      '--baseline',
      aspcCliPath(),
      '--candidate',
      aspcCliPath(),
      '--corpus',
      writeGoldCorpusFixture(),
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ])
    expect(report.status, report.stderr).toBe(0)
    expect(JSON.parse(report.stdout)).toMatchObject({
      mode: 'A',
      authorizesCutover: false,
    })
  })

  test('AC3: Mode B hashes raw file bytes, raw byte size, and raw symlink targets', async () => {
    const probeDir = join(fixture.aspHome, 'codex-homes', 'raw-byte-probe')
    mkdirSync(probeDir, { recursive: true })
    const rawPath = join(probeDir, 'invalid-utf8.bin')
    const rawBytes = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00]),
      Buffer.from(`${fixture.aspHome}\n2026-08-18T12:34:56.789Z\n${'a'.repeat(64)}\n`, 'utf8'),
    ])
    writeFileSync(rawPath, rawBytes)
    const rawTarget = `${fixture.aspHome}/target-${'b'.repeat(64)}-2026-08-18T12:34:56Z`
    symlinkSync(rawTarget, join(probeDir, 'raw-target-link'))

    const modeB = await buildManifest('B', 'mode_b_raw')
    const modeA = await buildManifest('A', 'mode_a_normalized')
    const rawEntry = requireManifestEntry(modeB, 'codex-homes/raw-byte-probe/invalid-utf8.bin')
    const normalizedEntry = requireManifestEntry(
      modeA,
      'codex-homes/raw-byte-probe/invalid-utf8.bin'
    )
    const linkEntry = requireManifestEntry(modeB, 'codex-homes/raw-byte-probe/raw-target-link')

    expect(rawEntry.size).toBe(rawBytes.byteLength)
    expect(rawEntry.sha256).toBe(sha256Hex(rawBytes))
    expect(rawEntry).not.toEqual(normalizedEntry)
    expect(linkEntry.sha256).toBe(sha256Hex(`symlink:${rawTarget}`))
  })

  test('AC4: Mode B walks the full ASP_HOME and fails loudly on unreadable directories', async () => {
    const cachePath = join(fixture.aspHome, 'cache', 'plugin-cache', 'plugin.txt')
    const promptPath = join(
      fixture.aspHome,
      'bundles',
      'v1',
      '.asp-runtime-artifacts',
      'system-prompt.md'
    )
    mkdirSync(join(fixture.aspHome, 'cache', 'plugin-cache'), { recursive: true })
    mkdirSync(join(fixture.aspHome, 'bundles', 'v1', '.asp-runtime-artifacts'), {
      recursive: true,
    })
    writeFileSync(cachePath, 'plugin cache emission\n')
    writeFileSync(promptPath, 'system prompt emission\n')

    const manifest = await buildManifest('B', 'whole_home_walk')
    expect(manifest.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'cache/plugin-cache/plugin.txt',
        'bundles/v1/.asp-runtime-artifacts/system-prompt.md',
      ])
    )

    const unreadable = join(fixture.aspHome, 'walk-error-probe')
    mkdirSync(unreadable, { recursive: true })
    writeFileSync(join(unreadable, 'must-not-disappear.txt'), 'emitted\n')
    const readable = await buildManifest('B', 'readable_walk_control')
    expect(readable.entries.map((entry) => entry.path)).toContain(
      'walk-error-probe/must-not-disappear.txt'
    )

    chmodSync(unreadable, 0o000)
    try {
      let caught: unknown
      try {
        await buildManifest('B', 'unreadable_walk')
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      const message = caught instanceof Error ? caught.message : String(caught)
      expect(message).toMatch(
        /walk-error-probe.*(?:permission|EACCES)|(?:permission|EACCES).*walk-error-probe/i
      )
      expect(message).not.toContain('manifest compile failed')
    } finally {
      chmodSync(unreadable, 0o755)
    }
  })

  test('AC5: exclusions are committed exact declarations with lock-only reasons and visible entries', async () => {
    const lockDir = join(fixture.aspHome, 'codex-homes', 'locks')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'runtime.lock'), 'ephemeral lock\n')

    const manifest = await buildManifest('B', 'declared_lock')
    expect(manifest.exclusions).toContainEqual({
      path: 'codex-homes/locks/runtime.lock',
      reason: 'ephemeral-lock',
    })
    expect(manifest.entries.some((entry) => entry.path.endsWith('.lock'))).toBe(false)

    writeFileSync(join(lockDir, 'unlisted.lock'), 'not declared\n')
    await expect(buildManifest('B', 'undeclared_lock')).rejects.toThrow(
      /unlisted\.lock.*declared exclusion|declared exclusion.*unlisted\.lock/i
    )
  })

  test('AC6: Mode B compares identical binaries, rejects bless, and refuses Mode A evidence', () => {
    const corpusCase = writeScenarioCase('same-binary-raw-diff', { expect: 'none' })
    const verifyArgs = (emitter: string) => [
      'verify-release',
      '--mode',
      'b',
      '--baseline',
      emitter,
      '--candidate',
      emitter,
      '--corpus',
      corpusCase,
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ]

    const stableEmitter = writeManifestEmitter('B', 'stable-mode-b-emitter', false)
    const stable = runAspcCli(verifyArgs(stableEmitter))
    expect(stable.status, stable.stderr).toBe(0)
    expect(JSON.parse(stable.stdout)).toMatchObject({
      mode: 'B',
      verdict: 'byte-identical',
      differences: [],
      authorizesCutover: true,
    })

    const changingEmitter = writeManifestEmitter('B', 'changing-mode-b-emitter')
    const baseArgs = verifyArgs(changingEmitter)
    const compared = runAspcCli(baseArgs)
    expect(compared.status).not.toBe(0)
    expect(JSON.parse(compared.stdout)).toMatchObject({
      mode: 'B',
      verdict: 'deterministic-diff',
      differences: [expect.objectContaining({ path: 'probe.bin' })],
    })

    const blessed = runAspcCli([...baseArgs, '--bless'])
    expect(blessed.status).not.toBe(0)
    expect(blessed.stderr).toMatch(/bless.*mode b|mode b.*bless/i)
    expect(blessed.stdout).not.toContain('blessed')

    const modeAEmitter = writeManifestEmitter('A', 'mode-a-emitter')
    const mismatched = runAspcCli(verifyArgs(modeAEmitter))
    expect(mismatched.status).not.toBe(0)
    expect(mismatched.stderr).toMatch(/mode.*(?:mismatch|A.*B)|A.*mode b/i)
    expect(mismatched.stdout).toBe('')
  })

  test('AC7: scenario classification is declared and a missing scenario.json is a named hard error', () => {
    const declared = writeScenarioCase('content-prompt-change', {
      class: 'mechanics',
      attribution: 'modelCatalog',
    })
    const declaredResult = runAspcCli([
      'verify-release',
      '--mode',
      'a',
      '--baseline',
      aspcCliPath(),
      '--candidate',
      aspcCliPath(),
      '--corpus',
      declared,
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ])
    expect(declaredResult.status).not.toBe(0)
    expect(JSON.parse(declaredResult.stdout)).toMatchObject({
      differences: [expect.objectContaining({ class: 'mechanics', attribution: 'modelCatalog' })],
    })

    const missing = writeScenarioCase('missing-scenario-case', undefined)
    const missingResult = runAspcCli([
      'verify-release',
      '--mode',
      'a',
      '--baseline',
      aspcCliPath(),
      '--candidate',
      aspcCliPath(),
      '--corpus',
      missing,
      '--compile-context',
      JSON.stringify(fixedCompileContext),
    ])
    expect(missingResult.status).not.toBe(0)
    expect(missingResult.stderr).toMatch(/missing-scenario-case.*scenario\.json/i)
    expect(missingResult.stdout).toBe('')
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
    `version = 3

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
    '../../../harness/harness-broker/test/fixtures/fake-codex/start-fresh-turn.ts',
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
    args: ['harness/aspc-facade/bin/aspc-facade.js', 'run', '--transport', 'stdio'],
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
    join(identicalCase, 'scenario.json'),
    `${JSON.stringify({ expect: 'none' }, null, 2)}\n`,
    'utf8'
  )
  writeFileSync(
    join(mechanicsCase, 'request.json'),
    `${JSON.stringify(buildCompileRequest('mechanics_model_bump'), null, 2)}\n`,
    'utf8'
  )
  writeFileSync(
    join(mechanicsCase, 'scenario.json'),
    `${JSON.stringify({ class: 'mechanics', attribution: 'modelCatalog' }, null, 2)}\n`,
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
  writeFileSync(
    join(contentCase, 'scenario.json'),
    `${JSON.stringify({ class: 'content', attribution: 'prompt' }, null, 2)}\n`,
    'utf8'
  )
  return corpusRoot
}

type ScenarioFixture = { expect: 'none' } | { class: 'mechanics' | 'content'; attribution: string }

function writeScenarioCase(caseId: string, scenario: ScenarioFixture | undefined): string {
  const caseDir = join(fixture.base, 'scenario-cases', caseId)
  mkdirSync(caseDir, { recursive: true })
  writeFileSync(
    join(caseDir, 'request.json'),
    `${JSON.stringify(
      buildCompileRequest(caseId.replace(/[^a-z0-9]/gi, '_'), {
        initialPrompt: `Prompt for ${caseId}`,
      }),
      null,
      2
    )}\n`,
    'utf8'
  )
  if (scenario !== undefined) {
    writeFileSync(join(caseDir, 'scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`, 'utf8')
  }
  return caseDir
}

function writeManifestEmitter(mode: 'A' | 'B', name: string, alternating = true): string {
  const emitterPath = join(fixture.base, `${name}.ts`)
  const statePath = join(fixture.base, `${name}.count`)
  const toolchainManifestHash = sha256Hex(canonicalJson(fixedCompileContext.toolchainManifest))
  const digestExpression = alternating
    ? "(count % 2 === 0 ? 'a' : 'b').repeat(64)"
    : "'a'.repeat(64)"
  writeFileSync(
    emitterPath,
    `#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'

const statePath = ${JSON.stringify(statePath)}
let count = 0
while (true) {
  try {
    mkdirSync(statePath + '.' + count)
    break
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    count += 1
  }
}
const sha256 = ${digestExpression}
const entries = [{ path: 'probe.bin', kind: 'file', size: 1, sha256, mode: '644' }]
const toolchainManifestHash = ${JSON.stringify(toolchainManifestHash)}
const canonicalJson = (value: unknown): string => {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort)
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)])
      )
    }
    return item
  }
  return JSON.stringify(sort(value))
}
const outputManifestHash = createHash('sha256')
  .update(canonicalJson({ mode: ${JSON.stringify(mode)}, entries, toolchainManifestHash }), 'utf8')
  .digest('hex')
process.stdout.write(
  JSON.stringify({
    schemaVersion: 'agent-output-manifest/v1',
    mode: ${JSON.stringify(mode)},
    outputManifestHash,
    startedHarness: false,
    toolchainManifestHash,
    entries,
    exclusions: [],
  }) + '\\n'
)
`,
    'utf8'
  )
  chmodSync(emitterPath, 0o755)
  return emitterPath
}

async function buildManifest(mode: 'A' | 'B', namespace: string): Promise<OutputManifest> {
  const input = {
    compileRequest: buildCompileRequest(namespace),
    aspHome: fixture.aspHome,
    compileContext: fixedCompileContext,
    mode,
  } as Parameters<typeof buildOutputManifest>[0] & { mode: 'A' | 'B' }
  const result = await buildOutputManifest(input)
  if (!result.ok) {
    throw new Error(`manifest compile failed: ${JSON.stringify(result.diagnostics)}`)
  }
  return result.manifest
}

function requireManifestEntry(manifest: OutputManifest, path: string) {
  const entry = manifest.entries.find((candidate) => candidate.path === path)
  expect(entry, `missing manifest entry ${path}`).toBeDefined()
  if (entry === undefined) throw new Error(`missing manifest entry ${path}`)
  return entry
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
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
  return join(repoRoot, 'compiler/aspc/bin/aspc.js')
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
