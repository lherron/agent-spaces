#!/usr/bin/env bun
/**
 * Deterministic CI smoke for the pre-HRC broker contract harness (PR5, plan §3.3).
 *
 * Runs the FULL compile → select → verify → broker-start → event-ledger path
 * WITHOUT real Codex/auth/network. The real harness-broker process IS spawned,
 * but its Codex app-server binary is resolved to a fake JSON-RPC fixture via
 * ASP_CODEX_PATH (+ ASP_CODEX_SKIP_COMMON_PATHS), reusing the harness-broker
 * testing substrate (test/fixtures/fake-codex + src/testing/fake-codex-app-server).
 *
 * Exit codes:
 *   0  contract verified (compile → broker → ledger ok, terminal turn reached)
 *   1  contract failure (assertion report has failures / no terminal turn)
 *   2  harness/setup error
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { runPreHrcBrokerContractHarness } from '../packages/agent-spaces/src/testing/pre-hrc-broker-contract-harness.js'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../packages/agent-spaces/src/testing/pre-hrc-broker-helpers.js'

type CliArgs = { json: boolean; keepArtifacts: boolean; help: boolean }

const SCOPE_REF = 'cody@agent-spaces'
const PROMPT = 'pre-HRC fake-broker CI smoke; reply ASP_RUNTIME_CONTRACT_OK.'

// Absolute path to the fake Codex app-server fixture. The shim below execs it
// in place of a real `codex app-server`, so the broker speaks JSON-RPC to a
// deterministic in-repo process — no auth, no network, no real model.
const fakeCodexFixture = new URL(
  '../packages/harness-broker/test/fixtures/fake-codex/start-fresh-turn.ts',
  import.meta.url
).pathname

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, keepArtifacts: false, help: false }
  for (const arg of argv) {
    switch (arg) {
      case '--json':
        args.json = true
        break
      case '--keep-artifacts':
        args.keepArtifacts = true
        break
      case '--help':
        args.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  bun scripts/smoke-runtime-contract-broker-fake-codex.ts [options]',
      '',
      'Runs the full compile → broker-start → event-ledger contract path against a',
      'fake Codex app-server. Deterministic; safe for CI (no real Codex/auth/network).',
      '',
      'Options:',
      '  --json              Print the harness result as JSON',
      '  --keep-artifacts    Do not delete the temp fixture/artifact dir on exit',
      '  --help              Show this message',
    ].join('\n')
  )
}

/** Build a self-contained fixture (agent root, project root, ASP home, shim). */
function createFixture(): {
  agentRoot: string
  projectRoot: string
  aspHome: string
  artifactDir: string
  codexPath: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-prehrc-fake-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const artifactDir = join(aspHome, 'pre-hrc-contract-artifacts')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2

[spaces]
base = []

[brain]
enabled = false
`,
    'utf8'
  )

  const codexPath = join(aspHome, 'codex')
  writeFileSync(
    codexPath,
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
  exec bun "${fakeCodexFixture}"
fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(codexPath, 0o755)

  return {
    agentRoot,
    projectRoot,
    aspHome,
    artifactDir,
    codexPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function compileRequest(fixture: ReturnType<typeof createFixture>): RuntimeCompileRequest {
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: 'prehrc_fake',
    invocationId: 'inv_prehrc_fake',
    initialInputId: 'input_prehrc_fake',
    idempotencyKey: 'pre-hrc-broker-contract-fake',
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: SCOPE_REF,
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    env: { OPENAI_API_KEY: 'sk-FAKE-CI-NOT-A-SECRET', PATH: process.env['PATH'] ?? '' },
    hostSessionId: identity.hostSessionId,
  })
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: 'openai',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: PROMPT,
      taskContext: {
        taskId: 'pre-hrc-broker-contract-fake',
        phase: 'contract',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'pre-HRC broker contract fake-codex CI smoke',
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
      observability: { traceId: identity.traceId },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
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
      appSessionKey: 'pre-hrc-broker-contract-fake',
      scopeRef: SCOPE_REF,
      laneRef: 'main',
    },
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return 0
  }

  const fixture = createFixture()
  const originalCodexPath = process.env['ASP_CODEX_PATH']
  const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  process.env['ASP_CODEX_PATH'] = fixture.codexPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

  try {
    const result = await runPreHrcBrokerContractHarness({
      schemaVersion: 'pre-hrc-broker-contract-harness-input/v1',
      compileRequest: compileRequest(fixture),
      aspHome: fixture.aspHome,
      artifactDir: fixture.artifactDir,
      dryRunCompile: false,
      timeoutMs: 10_000,
    })

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
    }

    const brokerStart = result.brokerStart
    const attempted = brokerStart?.attempted === true
    const terminalTurnTypes = ['turn.completed', 'turn.failed', 'turn.interrupted']
    const eventTypes = brokerStart?.attempted === true ? brokerStart.eventTypes : []
    const terminalTurn = eventTypes.find((type) => terminalTurnTypes.includes(type))
    const skippedReason = brokerStart?.attempted === false ? brokerStart.reason : 'unknown'

    console.log('pre-HRC fake-broker contract smoke')
    console.log(`  mode:          ${result.mode}`)
    console.log(`  ok:            ${result.ok}`)
    console.log(`  brokerStart:   ${attempted ? 'attempted' : `skipped (${skippedReason})`}`)
    console.log(`  terminalTurn:  ${terminalTurn ?? '(none)'}`)
    console.log(`  brokerEvents:  ${eventTypes.length} (${eventTypes.join(', ')})`)
    console.log(`  artifactDir:   ${result.artifacts?.artifactDir ?? '(not written)'}`)

    for (const failure of result.assertionReport.failures) {
      console.error(
        `  FAIL ${failure.code}${failure.path ? ` @ ${failure.path}` : ''}: ${failure.message}`
      )
    }

    if (!result.ok) return 1
    if (!attempted) {
      console.error('  FAIL: broker start was not attempted on a fake-codex run.')
      return 1
    }
    if (terminalTurn === undefined) {
      console.error('  FAIL: scenario did not reach a terminal turn event.')
      return 1
    }

    console.log('OK: full compile → broker → ledger path verified against fake Codex.')
    return 0
  } finally {
    process.env['ASP_CODEX_PATH'] = originalCodexPath
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
    if (args.keepArtifacts) {
      console.log(`(kept fixture/artifacts; ASP home: ${fixture.aspHome})`)
    } else {
      fixture.cleanup()
    }
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exit(2)
}
