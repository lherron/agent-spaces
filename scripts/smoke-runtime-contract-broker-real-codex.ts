#!/usr/bin/env bun
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { BrokerPermissionPolicy, RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { runPreHrcBrokerContractHarness } from '../packages/agent-spaces/src/testing/pre-hrc-broker-contract-harness.js'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../packages/agent-spaces/src/testing/pre-hrc-broker-helpers.js'

type CliArgs = {
  scopeRef: string
  agentRoot?: string | undefined
  projectRoot: string
  cwd: string
  aspHome: string
  artifactDir: string
  prompt: string
  model?: string | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
  permissionMode: 'deny' | 'allow' | 'ask-client'
  timeout: number
  invocationId: string
  initialInputId: string
  dryRunCompile: boolean
  writeRawStartRequest: boolean
  json: boolean
  help: boolean
}

const DEFAULT_PROMPT =
  'Execute the shell command `pwd`. Do not execute any other shell commands. Then reply with ASP_RUNTIME_CONTRACT_OK.'

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  bun scripts/smoke-runtime-contract-broker-real-codex.ts --dry-run-compile [options]',
      '',
      'Options:',
      '  --scope-ref <handle>             Scope handle, e.g. cody@agent-spaces (default: cody@agent-spaces)',
      '  --agent-root <path>              Agent root directory (default: <repo>/../var/agents/<agent>)',
      '  --project-root <path>            Project root directory (default: current working directory)',
      '  --cwd <path>                     Runtime working directory (default: project root)',
      '  --asp-home <path>                ASP home for materialization (default: /tmp/asp-runtime-contract-broker)',
      '  --artifact-dir <path>            Artifact output directory (default: <asp-home>/pre-hrc-contract-artifacts)',
      '  --prompt <text>                  Initial prompt for compiled broker input',
      '  --model <id>                     Requested OpenAI model',
      '  --reasoning-effort <level>       low, medium, high, or xhigh',
      '  --permission-mode <mode>         deny, allow, or ask-client (default: deny)',
      '  --timeout <seconds>              Startup/turn timeout seconds (default: 120)',
      '  --invocation-id <id>             Broker invocation id',
      '  --initial-input-id <id>          Initial broker input id',
      '  --dry-run-compile                Compile, select broker profile, assert contract, and write artifacts',
      '  --write-raw-start-request        Loud unsafe debug artifact; only allowed under OS temp dir',
      '  --json                           Print result JSON',
      '  --help                           Show this message',
      '',
      'Broker start is intentionally not wired in this P1 skeleton. Use --dry-run-compile.',
    ].join('\n')
  )
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.length === 0) throw new Error(`Missing value for ${flag}`)
  return value
}

function parseArgs(argv: string[]): CliArgs {
  const now = Math.floor(Date.now() / 1000)
  const projectRoot = process.cwd()
  const aspHome = '/tmp/asp-runtime-contract-broker'
  const args: CliArgs = {
    scopeRef: 'cody@agent-spaces',
    projectRoot,
    cwd: projectRoot,
    aspHome,
    artifactDir: join(aspHome, 'pre-hrc-contract-artifacts'),
    prompt: DEFAULT_PROMPT,
    permissionMode: 'deny',
    timeout: 120,
    invocationId: `inv_prehrc_${now}`,
    initialInputId: `input_prehrc_${now}`,
    dryRunCompile: false,
    writeRawStartRequest: false,
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
        args.help = true
        return args
      case '--scope-ref':
        args.scopeRef = readValue(argv, i, arg)
        i += 1
        break
      case '--agent-root':
        args.agentRoot = readValue(argv, i, arg)
        i += 1
        break
      case '--project-root':
        args.projectRoot = resolve(readValue(argv, i, arg))
        if (args.cwd === projectRoot) args.cwd = args.projectRoot
        i += 1
        break
      case '--cwd':
        args.cwd = resolve(readValue(argv, i, arg))
        i += 1
        break
      case '--asp-home':
        args.aspHome = resolve(readValue(argv, i, arg))
        if (args.artifactDir === join(aspHome, 'pre-hrc-contract-artifacts')) {
          args.artifactDir = join(args.aspHome, 'pre-hrc-contract-artifacts')
        }
        i += 1
        break
      case '--artifact-dir':
        args.artifactDir = resolve(readValue(argv, i, arg))
        i += 1
        break
      case '--prompt':
        args.prompt = readValue(argv, i, arg)
        i += 1
        break
      case '--model':
        args.model = readValue(argv, i, arg)
        i += 1
        break
      case '--reasoning-effort': {
        const value = readValue(argv, i, arg)
        if (value !== 'low' && value !== 'medium' && value !== 'high' && value !== 'xhigh') {
          throw new Error('--reasoning-effort must be one of: low, medium, high, xhigh')
        }
        args.reasoningEffort = value
        i += 1
        break
      }
      case '--permission-mode': {
        const value = readValue(argv, i, arg)
        if (value !== 'deny' && value !== 'allow' && value !== 'ask-client') {
          throw new Error('--permission-mode must be one of: deny, allow, ask-client')
        }
        args.permissionMode = value
        i += 1
        break
      }
      case '--timeout':
        args.timeout = Number(readValue(argv, i, arg))
        if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
          throw new Error('--timeout must be a positive number')
        }
        i += 1
        break
      case '--invocation-id':
        args.invocationId = readValue(argv, i, arg)
        i += 1
        break
      case '--initial-input-id':
        args.initialInputId = readValue(argv, i, arg)
        i += 1
        break
      case '--dry-run-compile':
        args.dryRunCompile = true
        break
      case '--write-raw-start-request':
        args.writeRawStartRequest = true
        break
      case '--json':
        args.json = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function permissionPolicy(args: CliArgs): BrokerPermissionPolicy {
  if (args.permissionMode === 'allow') {
    return {
      mode: 'allow',
      audit: true,
      provenance: {
        source: 'test',
        requestId: 'request_prehrc_contract',
        createdAt: new Date().toISOString(),
      },
    }
  }
  if (args.permissionMode === 'ask-client') {
    return {
      mode: 'ask-client',
      timeoutMs: args.timeout * 1000,
      defaultDecision: 'deny',
      surface: 'api',
      audit: true,
    }
  }
  return { mode: 'deny', audit: true }
}

function compileRequest(args: CliArgs): RuntimeCompileRequest {
  const timeoutMs = args.timeout * 1000
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: 'prehrc_contract',
    invocationId: args.invocationId,
    initialInputId: args.initialInputId,
    idempotencyKey: 'pre-hrc-broker-contract',
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: args.scopeRef,
    agentRoot: args.agentRoot,
    projectRoot: args.projectRoot,
    cwd: args.cwd,
    env: process.env,
    hostSessionId: identity.hostSessionId,
  })
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: 'openai',
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: args.prompt,
      taskContext: {
        taskId: 'pre-hrc-broker-contract',
        phase: 'contract',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'pre-HRC broker contract harness',
      },
    },
    hrcPolicy: {
      permissionPolicy: permissionPolicy(args),
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: timeoutMs, turnTimeoutMs: timeoutMs },
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
      appSessionKey: 'pre-hrc-broker-contract',
      scopeRef: args.scopeRef,
      laneRef: 'main',
    },
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }
  if (!args.dryRunCompile) {
    throw new Error(
      'P1 skeleton only supports --dry-run-compile; broker start lands in a later stream.'
    )
  }

  mkdirSync(args.aspHome, { recursive: true })
  const result = await runPreHrcBrokerContractHarness({
    schemaVersion: 'pre-hrc-broker-contract-harness-input/v1',
    compileRequest: compileRequest(args),
    aspHome: args.aspHome,
    artifactDir: args.artifactDir,
    dryRunCompile: args.dryRunCompile,
    writeRawStartRequest: args.writeRawStartRequest,
  })

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`pre-HRC broker contract: ${result.ok ? 'ok' : 'failed'}`)
    console.log(`mode: ${result.mode}`)
    console.log(`artifactDir: ${result.artifacts?.artifactDir ?? '(not written)'}`)
    for (const failure of result.assertionReport.failures) {
      console.error(`${failure.code}: ${failure.message}`)
    }
  }

  if (!result.ok) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
