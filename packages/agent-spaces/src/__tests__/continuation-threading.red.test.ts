/**
 * Continuation key threading no-loss regression guards — T-04829 Phase 1.
 *
 * Asserts that the SAME key string survives every hop for all three harness
 * routes: codex-app-server, codex-cli-tmux, claude-code-tmux.
 *
 *   RuntimeCompileRequest.continuation.hrc.key
 *     → BuildHarnessBrokerInvocationRequest.continuation.key  (compile-runtime-plan.ts:854)
 *     → HarnessInvocationSpec.continuation.key  (broker-invocation.ts:331,389 | compile-runtime-plan.ts:1608)
 *     → resume argv / resumeThreadId  (claude-adapter.ts:539 | codex-adapter.ts:316)
 *
 * These are GREEN GUARDS: the threading is already wired. These tests fire if
 * any hop silently drops or remaps the key. Co-located per T-04829 scope.
 */
import { afterAll, beforeAll, test as bunTest, describe, expect } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HarnessInvocationSpec, InputId, InvocationId } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../index.js'
import type { AgentSpacesClient } from '../types.js'

// ---------------------------------------------------------------------------
// Timeout & type helpers
// ---------------------------------------------------------------------------

type TestFn = () => unknown | Promise<unknown>
const HEAVY_MS = 60_000
function test(name: string, fn: TestFn) {
  bunTest(name, fn, HEAVY_MS)
}

type CompileClient = AgentSpacesClient & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

// ---------------------------------------------------------------------------
// The continuation key under test — same sentinel checked at each hop
// ---------------------------------------------------------------------------
const CODEX_KEY = 'thread_T04829_noloss'
const CLAUDE_KEY = 'claude-session-T04829-noloss'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function createCodexShim(dir: string): void {
  const p = join(dir, 'codex')
  writeFileSync(
    p,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "codex 999.0.0"; exit 0; fi
if [[ "$1" == "app-server" && "$2" == "--help" ]]; then echo "app-server"; exit 0; fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(p, 0o755)
}

function createClaudeShim(dir: string): void {
  const p = join(dir, 'claude')
  writeFileSync(
    p,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "claude 1.0.0"; exit 0; fi
echo "claude shim"
`,
    'utf8'
  )
  chmodSync(p, 0o755)
}

function createFixture() {
  const base = mkdtempSync(join(tmpdir(), 'asp-continuation-threading-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    'schemaVersion = 2\n\n[spaces]\nbase = []\n\n[brain]\nenabled = false\n',
    'utf8'
  )
  createClaudeShim(aspHome)
  createCodexShim(aspHome)
  return {
    agentRoot,
    projectRoot,
    aspHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

let fixture: ReturnType<typeof createFixture>
const origClaudePath = process.env['ASP_CLAUDE_PATH']
const origCodexPath = process.env['ASP_CODEX_PATH']
const origSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

// ---------------------------------------------------------------------------
// Client & profile helpers
// ---------------------------------------------------------------------------

function createClient(): CompileClient {
  return createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
}

function brokerProfile(response: RuntimeCompileResponse): BrokerExecutionProfile {
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error(
      `compileRuntimePlan failed: ${response.diagnostics.map((d) => d.code).join(', ')}`
    )
  }
  const profiles = response.plan.executionProfiles.filter(
    (p): p is BrokerExecutionProfile => p.kind === 'harness-broker'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

function specFromProfile(profile: BrokerExecutionProfile): HarnessInvocationSpec {
  return profile.harnessInvocation.startRequest.spec
}

// ---------------------------------------------------------------------------
// Shared base request
// ---------------------------------------------------------------------------

function basePlacement() {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task' as const,
    bundle: {
      kind: 'agent-project' as const,
      agentName: 'cody',
      projectRoot: fixture.projectRoot,
    },
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04829',
        laneRef: 'main',
      },
      hostSessionId: 'host-T04829',
    },
  }
}

function baseHrcPolicy() {
  return {
    permissionPolicy: { mode: 'deny' as const, audit: true },
    inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
    exposurePolicy: { mode: 'none' as const },
    resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
    observability: { traceId: 'trace_T04829' },
    capabilityPolicy: {
      allowDegrade: false,
      requireBrokerDefaultForCodexHeadless: true,
    },
  }
}

function baseCorrelation() {
  return {
    requestId: 'request_T04829',
    operationId: 'op_T04829',
    hostSessionId: 'host_T04829',
    generation: 1,
    runtimeId: 'runtime_T04829',
    runId: 'run_T04829',
    invocationId: 'inv_T04829' as InvocationId,
    traceId: 'trace_T04829',
    appId: 'agent-spaces-tests',
    appSessionKey: 'continuation-threading',
    scopeRef: 'agent:cody:project:agent-spaces:task:T-04829',
    laneRef: 'main',
  }
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

describe('continuation threading no-loss regression guards (T-04829)', () => {
  beforeAll(() => {
    fixture = createFixture()
    process.env['ASP_CLAUDE_PATH'] = join(fixture.aspHome, 'claude')
    process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  })

  afterAll(() => {
    if (origClaudePath === undefined) {
      process.env['ASP_CLAUDE_PATH'] = undefined
    } else {
      process.env['ASP_CLAUDE_PATH'] = origClaudePath
    }
    if (origCodexPath === undefined) {
      process.env['ASP_CODEX_PATH'] = undefined
    } else {
      process.env['ASP_CODEX_PATH'] = origCodexPath
    }
    if (origSkipCommon === undefined) {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
    } else {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = origSkipCommon
    }
    fixture.cleanup()
  })

  // =========================================================================
  // Route 1: codex-app-server (headless)
  // =========================================================================
  describe('Route 1 — codex-app-server (headless): continuation key reaches spec + driver', () => {
    function codexAppServerRequest(): RuntimeCompileRequest {
      return {
        schemaVersion: 'agent-runtime-compile-request/v1',
        identity: {
          requestId: 'request_T04829',
          operationId: 'op_T04829',
          hostSessionId: 'host_T04829',
          generation: 1,
          runtimeId: 'runtime_T04829',
          invocationId: 'inv_T04829' as InvocationId,
          initialInputId: 'input_T04829' as InputId,
          runId: 'run_T04829',
          traceId: 'trace_T04829',
          idempotencyKey: 'continuation-threading-codex-app-server',
        },
        placement: basePlacement(),
        requested: {
          modelProvider: 'openai',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          harnessFamily: 'codex',
          preferredHarnessRuntime: 'codex-cli',
          interactionMode: 'headless',
        },
        materialization: {
          initialPrompt: 'T-04829 codex-app-server continuation threading probe',
          attachments: [],
          taskContext: {
            taskId: 'T-04829',
            phase: 'red',
            role: 'smokey',
            requiredEvidenceKinds: ['red-test'],
            hintsText:
              'continuation key must survive compile → broker invocation → spec without loss',
          },
        },
        hrcPolicy: baseHrcPolicy(),
        continuation: {
          schemaVersion: 'runtime-continuation/v1',
          hrc: { provider: 'openai', keyHash: 'codex-hash-04829', key: CODEX_KEY },
          broker: {
            provider: 'codex',
            kind: 'thread',
            keyHash: 'codex-hash-04829',
            key: CODEX_KEY,
          },
          source: 'harness-broker',
          observedAt: '2026-06-15T12:00:00.000Z',
        },
        correlation: baseCorrelation(),
      }
    }

    test('spec.continuation carries provider:codex, kind:thread, and the SAME key', async () => {
      const s = specFromProfile(
        brokerProfile(await createClient().compileRuntimePlan(codexAppServerRequest()))
      )

      expect(s.continuation).toBeDefined()
      expect(s.continuation?.provider).toBe('codex')
      expect(s.continuation?.kind).toBe('thread')
      expect(s.continuation?.key).toBe(CODEX_KEY)
    })

    test('driver.resumeThreadId carries the SAME key (no truncation or remap)', async () => {
      const s = specFromProfile(
        brokerProfile(await createClient().compileRuntimePlan(codexAppServerRequest()))
      )

      // resumeThreadId is set at broker-invocation.ts:352
      expect((s.driver as { resumeThreadId?: string }).resumeThreadId).toBe(CODEX_KEY)
    })

    test('compileBrokerPlan sets resumeFallback:fail when a continuation key is present', async () => {
      const s = specFromProfile(
        brokerProfile(await createClient().compileRuntimePlan(codexAppServerRequest()))
      )

      // Ensures a missing JSONL fails visibly rather than silently starting fresh.
      // Set at compile-runtime-plan.ts:871.
      expect((s.driver as { resumeFallback?: string }).resumeFallback).toBe('fail')
    })
  })

  // =========================================================================
  // Route 2: codex-cli-tmux (interactive) — PRIMARY NEW TEST
  // =========================================================================
  describe('Route 2 — codex-cli-tmux (interactive): key reaches spec.continuation + resume subcommand', () => {
    function codexTmuxRequest(): RuntimeCompileRequest {
      return {
        schemaVersion: 'agent-runtime-compile-request/v1',
        identity: {
          requestId: 'request_T04829_ctmux',
          operationId: 'op_T04829_ctmux',
          hostSessionId: 'host_T04829_ctmux',
          generation: 1,
          runtimeId: 'runtime_T04829_ctmux',
          invocationId: 'inv_T04829_ctmux' as InvocationId,
          initialInputId: 'input_T04829_ctmux' as InputId,
          runId: 'run_T04829_ctmux',
          traceId: 'trace_T04829_ctmux',
          idempotencyKey: 'continuation-threading-codex-cli-tmux',
        },
        placement: basePlacement(),
        requested: {
          modelProvider: 'openai',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          harnessFamily: 'codex',
          preferredHarnessRuntime: 'codex-cli',
          interactionMode: 'interactive',
        },
        materialization: {
          initialPrompt: '',
          attachments: [],
          taskContext: {
            taskId: 'T-04829',
            phase: 'red',
            role: 'smokey',
            requiredEvidenceKinds: ['red-test'],
            hintsText: 'codex-cli-tmux continuation key threading no-loss',
          },
        },
        hrcPolicy: {
          ...baseHrcPolicy(),
          exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
        },
        continuation: {
          schemaVersion: 'runtime-continuation/v1',
          hrc: { provider: 'openai', keyHash: 'codex-hash-04829', key: CODEX_KEY },
          broker: {
            provider: 'codex',
            kind: 'thread',
            keyHash: 'codex-hash-04829',
            key: CODEX_KEY,
          },
          source: 'harness-broker',
          observedAt: '2026-06-15T12:00:00.000Z',
        },
        correlation: {
          ...baseCorrelation(),
          requestId: 'request_T04829_ctmux',
          operationId: 'op_T04829_ctmux',
          hostSessionId: 'host_T04829_ctmux',
          invocationId: 'inv_T04829_ctmux' as InvocationId,
          idempotencyKey: 'continuation-threading-codex-cli-tmux',
        },
      }
    }

    test('spec.driver.kind is codex-cli-tmux', async () => {
      const profile = brokerProfile(await createClient().compileRuntimePlan(codexTmuxRequest()))
      expect(specFromProfile(profile).driver.kind).toBe('codex-cli-tmux')
    })

    test('spec.continuation carries the SAME key (no loss through compile → tmux broker)', async () => {
      const s = specFromProfile(
        brokerProfile(await createClient().compileRuntimePlan(codexTmuxRequest()))
      )

      // Set at compile-runtime-plan.ts:1608
      expect(s.continuation).toBeDefined()
      expect(s.continuation?.key).toBe(CODEX_KEY)
    })

    test('process argv contains the resume subcommand (codex resume <key>)', async () => {
      const s = specFromProfile(
        brokerProfile(await createClient().compileRuntimePlan(codexTmuxRequest()))
      )

      // buildResumeArgs in codex-adapter.ts:316 produces ['resume', ..., key, ...]
      // The spec.process.args IS the codex argv (command is the codex binary path).
      expect(s.process.args).toContain('resume')
      expect(s.process.args).toContain(CODEX_KEY)
    })

    test('the continuation key appears AFTER the resume subcommand in argv (no positional swap)', async () => {
      const s = specFromProfile(
        brokerProfile(await createClient().compileRuntimePlan(codexTmuxRequest()))
      )

      const resumeIdx = s.process.args.indexOf('resume')
      const keyIdx = s.process.args.indexOf(CODEX_KEY)

      expect(resumeIdx).toBeGreaterThanOrEqual(0)
      expect(keyIdx).toBeGreaterThan(resumeIdx)
    })
  })

  // =========================================================================
  // Route 3: claude-code-tmux (interactive)
  // =========================================================================
  describe('Route 3 — claude-code-tmux (interactive): key reaches spec.continuation + --resume argv', () => {
    function claudeTmuxRequest(): RuntimeCompileRequest {
      return {
        schemaVersion: 'agent-runtime-compile-request/v1',
        identity: {
          requestId: 'request_T04829_cctmux',
          operationId: 'op_T04829_cctmux',
          hostSessionId: 'host_T04829_cctmux',
          generation: 1,
          runtimeId: 'runtime_T04829_cctmux',
          invocationId: 'inv_T04829_cctmux' as InvocationId,
          initialInputId: 'input_T04829_cctmux' as InputId,
          runId: 'run_T04829_cctmux',
          traceId: 'trace_T04829_cctmux',
          idempotencyKey: 'continuation-threading-claude-code-tmux',
        },
        placement: basePlacement(),
        requested: {
          modelProvider: 'anthropic',
          model: 'claude-sonnet-4-5',
          harnessFamily: 'claude-code',
          preferredHarnessRuntime: 'claude-code-cli',
          interactionMode: 'interactive',
        },
        materialization: {
          initialPrompt: '',
          attachments: [],
          taskContext: {
            taskId: 'T-04829',
            phase: 'red',
            role: 'smokey',
            requiredEvidenceKinds: ['red-test'],
            hintsText: 'claude-code-tmux continuation key threading no-loss',
          },
        },
        hrcPolicy: {
          ...baseHrcPolicy(),
          exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
        },
        continuation: {
          schemaVersion: 'runtime-continuation/v1',
          hrc: { provider: 'anthropic', keyHash: 'claude-hash-04829', key: CLAUDE_KEY },
          broker: {
            provider: 'anthropic',
            kind: 'session',
            keyHash: 'claude-hash-04829',
            key: CLAUDE_KEY,
          },
          source: 'harness-broker',
          observedAt: '2026-06-15T12:00:00.000Z',
        },
        correlation: {
          ...baseCorrelation(),
          requestId: 'request_T04829_cctmux',
          operationId: 'op_T04829_cctmux',
          hostSessionId: 'host_T04829_cctmux',
          invocationId: 'inv_T04829_cctmux' as InvocationId,
          idempotencyKey: 'continuation-threading-claude-code-tmux',
        },
      }
    }

    test('spec.driver.kind is claude-code-tmux', async () => {
      const profile = brokerProfile(await createClient().compileRuntimePlan(claudeTmuxRequest()))
      expect(specFromProfile(profile).driver.kind).toBe('claude-code-tmux')
    })

    test('spec.continuation carries provider:anthropic, kind:session, and the SAME key', async () => {
      const s = specFromProfile(
        brokerProfile(await createClient().compileRuntimePlan(claudeTmuxRequest()))
      )

      // Set at compile-runtime-plan.ts:1608 (via route.provider = 'anthropic')
      expect(s.continuation).toBeDefined()
      expect(s.continuation?.provider).toBe('anthropic')
      expect(s.continuation?.kind).toBe('session')
      expect(s.continuation?.key).toBe(CLAUDE_KEY)
    })

    test('process argv contains --resume <key> (buildSessionArgs in claude-adapter.ts:535)', async () => {
      const s = specFromProfile(
        brokerProfile(await createClient().compileRuntimePlan(claudeTmuxRequest()))
      )

      const resumeIdx = s.process.args.indexOf('--resume')
      expect(resumeIdx).toBeGreaterThanOrEqual(0)
      expect(s.process.args[resumeIdx + 1]).toBe(CLAUDE_KEY)
    })

    test('process argv does NOT contain --session-id when resuming (no fresh-start collision)', async () => {
      const s = specFromProfile(
        brokerProfile(await createClient().compileRuntimePlan(claudeTmuxRequest()))
      )

      expect(s.process.args).not.toContain('--session-id')
    })
  })
})
