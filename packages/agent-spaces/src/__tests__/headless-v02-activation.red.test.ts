/**
 * Ph4b RED tests: ASP-side v0.2 headless broker profile activation flag (T-01878)
 *
 * Asserts the TARGET state where compileRuntimePlan emits a v0.2 durable headless
 * broker profile (control.attachReplay === 'optional', the durable-attach/replay
 * capability shape) ONLY when the ASP_HEADLESS_DURABLE_BROKER=1 dev flag is set.
 *
 * Without the flag, the default remains the v0.1-style legacy headless profile
 * (control.attachReplay === 'forbidden'). The flag is temporary, default-OFF, and
 * operator-visible only — it must be read from the environment, not hard-wired.
 *
 * Tests FAIL today because:
 *   - No ASP_HEADLESS_DURABLE_BROKER flag logic exists in compile-runtime-plan.ts
 *   - The headless codex profile always emits control.attachReplay: 'forbidden'
 *     regardless of any environment variable (no v0.2 headless emission path)
 *   - Setting ASP_HEADLESS_DURABLE_BROKER=1 has zero effect on the compiled profile
 *
 * RED DISCIPLINE: each test fails with a behavioral assertion error, NOT a compile
 * or import error. The "right reason" is: no flag / no v0.2 headless emission path.
 *
 * Do NOT implement here — tests only.
 * Cross-ref: HRC-side selector/admission reds will land separately after Ph5 (T-01876).
 * Ph6 v0.1 removal (T-01867) is PARKED — do not fuse with this activation override.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../index.js'
import type { AgentSpacesClient } from '../types.js'

type CompileClient = AgentSpacesClient & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

// ---------------------------------------------------------------------------
// Minimal fixture — codex + claude shims, temp asp-home
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

interface Fixture {
  agentRoot: string
  projectRoot: string
  aspHome: string
  cleanup: () => void
}

function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'asp-headless-v02-activation-red-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2\n[spaces]\nbase = []\n[brain]\nenabled = false\n`,
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

// ---------------------------------------------------------------------------
// Shared state — env var save/restore
// ---------------------------------------------------------------------------

let fixture: Fixture
const origCodexPath = process.env['ASP_CODEX_PATH']
const origSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
const origClaudePath = process.env['ASP_CLAUDE_PATH']
const ACTIVATION_FLAG = 'ASP_HEADLESS_DURABLE_BROKER'

beforeAll(() => {
  fixture = createFixture()
  process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  process.env['ASP_CLAUDE_PATH'] = join(fixture.aspHome, 'claude')
})

afterAll(() => {
  // Restore original env
  if (origCodexPath === undefined) delete process.env['ASP_CODEX_PATH']
  else process.env['ASP_CODEX_PATH'] = origCodexPath
  if (origSkipCommon === undefined) delete process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  else process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = origSkipCommon
  if (origClaudePath === undefined) delete process.env['ASP_CLAUDE_PATH']
  else process.env['ASP_CLAUDE_PATH'] = origClaudePath
  // Ensure the activation flag is not left set by a failed test
  delete process.env[ACTIVATION_FLAG]
  fixture.cleanup()
})

function createClient(): CompileClient {
  return createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
}

function basePlacement(): RuntimeCompileRequest['placement'] {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
    lockedEnv: {},
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01878',
        laneRef: 'main',
      },
      hostSessionId: 'host-01878',
    },
  }
}

function headlessCodexRequest(): RuntimeCompileRequest {
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity: {
      requestId: 'request_T01878',
      operationId: 'op_T01878',
      hostSessionId: 'host_T01878',
      generation: 1,
      runtimeId: 'runtime_T01878',
      invocationId: 'inv_T01878' as InvocationId,
      initialInputId: 'input_T01878' as InputId,
      runId: 'run_T01878',
      traceId: 'trace_T01878',
      idempotencyKey: 'headless-v02-activation-red',
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
      initialPrompt: 'Ph4b red test v0.2 headless activation flag',
      attachments: [],
      taskContext: {
        taskId: 'T-01878',
        phase: 'red',
        role: 'smokey',
        requiredEvidenceKinds: ['red-test'],
        hintsText: 'durable-attach/replay capability shape must be emitted when flag is set',
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: false },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
      observability: { traceId: 'trace_T01878' },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
    },
    continuation: {
      schemaVersion: 'runtime-continuation/v1',
      hrc: { provider: 'openai', keyHash: 'thread-hash', key: 'thread_T01878' },
      broker: { provider: 'codex', kind: 'thread', keyHash: 'thread-hash', key: 'thread_T01878' },
      source: 'harness-broker',
      observedAt: '2026-06-04T20:00:00.000Z',
    },
    correlation: {
      requestId: 'request_T01878',
      operationId: 'op_T01878',
      hostSessionId: 'host_T01878',
      generation: 1,
      runtimeId: 'runtime_T01878',
      runId: 'run_T01878',
      invocationId: 'inv_T01878' as InvocationId,
      traceId: 'trace_T01878',
      appId: 'agent-spaces-tests',
      appSessionKey: 'headless-v02-activation-red',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01878',
      laneRef: 'main',
    },
  }
}

function extractBrokerProfile(response: RuntimeCompileResponse): BrokerExecutionProfile {
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error('compile failed: ' + JSON.stringify(response.diagnostics))
  const profiles = response.plan.executionProfiles.filter(
    (p): p is BrokerExecutionProfile => p.kind === 'harness-broker'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

// ---------------------------------------------------------------------------
// RED tests
// ---------------------------------------------------------------------------

describe('Ph4b red: compileRuntimePlan v0.2 headless activation flag (T-01878)', () => {
  test(
    'with ASP_HEADLESS_DURABLE_BROKER=1 → headless codex profile has durable-attach/replay capability (control.attachReplay === "optional") (RED)',
    async () => {
      // RED today: compile-runtime-plan.ts has no ASP_HEADLESS_DURABLE_BROKER flag logic.
      // The headless codex profile always emits control.attachReplay: 'forbidden'.
      // Setting this env var currently has zero effect on the compiled profile.
      // After Ph4b impl: the flag enables the durable-attach/replay capability shape.
      process.env[ACTIVATION_FLAG] = '1'
      try {
        const response = await createClient().compileRuntimePlan(headlessCodexRequest())
        const profile = extractBrokerProfile(response)
        // The v0.2 durable headless profile must advertise that attach+replay is
        // meaningful — 'optional' so HRC's route-specific overlay can require it.
        expect(profile.expectedCapabilities.control.attachReplay).toBe('optional')
      } finally {
        delete process.env[ACTIVATION_FLAG]
      }
    }
  )

  test(
    'with ASP_HEADLESS_DURABLE_BROKER=1 → headless codex profile does NOT retain control.attachReplay "forbidden" (the v0.1-style legacy sentinel) (RED)',
    async () => {
      // RED today: the activation flag is not implemented. The headless codex profile
      // always keeps control.attachReplay: 'forbidden' (v0.1-style) even when the
      // durable activation flag is set. After Ph4b impl: the flag switches the profile
      // to the durable-attach/replay shape and 'forbidden' no longer applies.
      process.env[ACTIVATION_FLAG] = '1'
      try {
        const response = await createClient().compileRuntimePlan(headlessCodexRequest())
        const profile = extractBrokerProfile(response)
        expect(profile.expectedCapabilities.control.attachReplay).not.toBe('forbidden')
      } finally {
        delete process.env[ACTIVATION_FLAG]
      }
    }
  )

  test(
    'ASP_HEADLESS_DURABLE_BROKER is env-read, not hardwired: flag ON produces durable capability; flag OFF (default) retains legacy capability (RED)',
    async () => {
      // RED today: ASP_HEADLESS_DURABLE_BROKER is not read anywhere in
      // compile-runtime-plan.ts. Setting vs unsetting the flag has no effect —
      // both compile calls produce identical control.attachReplay: 'forbidden'.
      // The with-flag assertion below fails, confirming the flag is inert.
      //
      // After Ph4b impl: the flag gates the durable-attach/replay capability shape.
      // The flag must NOT be a hardcoded constant or a durable launchd config entry —
      // it must be read from process.env at compile time (operator-visible only).
      process.env[ACTIVATION_FLAG] = '1'
      const withFlagResponse = await createClient().compileRuntimePlan(headlessCodexRequest())
      delete process.env[ACTIVATION_FLAG]
      const withoutFlagResponse = await createClient().compileRuntimePlan(headlessCodexRequest())

      const profileWithFlag = extractBrokerProfile(withFlagResponse)
      const profileWithoutFlag = extractBrokerProfile(withoutFlagResponse)

      // With flag: durable-attach/replay capability shape (RED today: no flag logic)
      expect(profileWithFlag.expectedCapabilities.control.attachReplay).toBe('optional')
      // Without flag: legacy v0.1-style capability (GREEN guard — confirmed default-OFF)
      expect(profileWithoutFlag.expectedCapabilities.control.attachReplay).toBe('forbidden')
    }
  )

  test(
    'with ASP_HEADLESS_DURABLE_BROKER=1 → headless codex profile has brokerProtocol === "harness-broker/0.2" (the HRC durable-route selector marker) (RED)',
    async () => {
      // RED today: compile-runtime-plan.ts has no ASP_HEADLESS_DURABLE_BROKER flag logic.
      // The headless codex profile always emits brokerProtocol: 'harness-broker/0.1' — the
      // default that HRC's broker-headless-handlers.ts uses to SKIP the durable route
      // (durable route requires String(compiled.profile.brokerProtocol) === 'harness-broker/0.2').
      // Without this marker, HRC never reaches the leased-tmux + Unix v0.2 IPC allocation,
      // so the durable path stays dead even if control.attachReplay is set correctly.
      //
      // After Ph4b impl: the flag must flip BOTH brokerProtocol AND control.attachReplay
      // together — a half-impl that sets only one leaves the activation gap open.
      //
      // Baseline: brokerProtocol stays 'harness-broker/0.1' by default (6fc8be2 revert
      // restored the stable v0.1 baseline; the Ph6 v0.1-removal revert is parked).
      process.env[ACTIVATION_FLAG] = '1'
      try {
        const response = await createClient().compileRuntimePlan(headlessCodexRequest())
        const profile = extractBrokerProfile(response)
        // The HRC durable-route selector gates on this exact string value.
        expect(profile.brokerProtocol).toBe('harness-broker/0.2')
      } finally {
        delete process.env[ACTIVATION_FLAG]
      }
    }
  )

  test(
    'without ASP_HEADLESS_DURABLE_BROKER → headless codex profile has brokerProtocol === "harness-broker/0.1" (stable v0.1-default, GREEN guard)',
    async () => {
      // GREEN guard — confirms the default-OFF baseline so a partial impl that
      // unconditionally flips brokerProtocol to v0.2 cannot silently pass all reds.
      // This MUST pass both before and after Ph4b impl (default is OFF).
      // It also verifies the Ph6 GREEN/revert did not leave v0.2 hardwired.
      const savedFlag = process.env[ACTIVATION_FLAG]
      delete process.env[ACTIVATION_FLAG]
      try {
        const response = await createClient().compileRuntimePlan(headlessCodexRequest())
        const profile = extractBrokerProfile(response)
        expect(profile.brokerProtocol).toBe('harness-broker/0.1')
      } finally {
        if (savedFlag !== undefined) process.env[ACTIVATION_FLAG] = savedFlag
      }
    }
  )
})
