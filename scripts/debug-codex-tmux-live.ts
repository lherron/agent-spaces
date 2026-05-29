#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type {
  InvocationInput,
  InvocationRuntimeContext,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  BrokerPermissionPolicy,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../packages/agent-spaces/src/index.js'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../packages/agent-spaces/src/testing/pre-hrc-broker-helpers.js'
import { allocatePreHrcTmuxPane } from '../packages/agent-spaces/src/testing/pre-hrc-tmux-allocator.js'
import { createBroker } from '../packages/harness-broker/src/broker'
import { createCodexCliTmuxDriver } from '../packages/harness-broker/src/drivers/codex-cli-tmux/driver'

type Args = {
  scopeRef: string
  agentRoot?: string | undefined
  projectRoot: string
  cwd: string
  prompt?: string | undefined
  noPrompt: boolean
  delayedInput: boolean
  timeoutMs: number
  cleanup: boolean
  noWait: boolean
  manualAttach: boolean
  ghostmuxTarget?: string | undefined
}

type TmuxResult = { stdout: string; stderr: string }
type GhostmuxResult = { code: number; stdout: string; stderr: string }

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scopeRef: 'sparky@agent-spaces',
    projectRoot: process.cwd(),
    cwd: process.cwd(),
    timeoutMs: 60_000,
    cleanup: false,
    noWait: false,
    noPrompt: false,
    delayedInput: false,
    manualAttach: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--scope':
        args.scopeRef = readValue(value, arg)
        i += 1
        break
      case '--agent-root':
        args.agentRoot = resolve(readValue(value, arg))
        i += 1
        break
      case '--project-root':
        args.projectRoot = resolve(readValue(value, arg))
        i += 1
        break
      case '--cwd':
        args.cwd = resolve(readValue(value, arg))
        i += 1
        break
      case '--prompt':
        args.prompt = readValue(value, arg)
        i += 1
        break
      case '--no-prompt':
        args.noPrompt = true
        break
      case '--delayed-input':
        args.delayedInput = true
        break
      case '--timeout-ms':
        args.timeoutMs = Number(readValue(value, arg))
        i += 1
        break
      case '--cleanup':
        args.cleanup = true
        break
      case '--no-wait':
        args.noWait = true
        break
      case '--manual-attach':
        args.manualAttach = true
        break
      case '--ghostmux-target':
        args.ghostmuxTarget = readValue(value, arg)
        i += 1
        break
      case '--help':
        printUsage()
        process.exit(0)
        return args
      case '-h':
        printUsage()
        process.exit(0)
        return args
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (args.agentRoot === undefined) {
    args.agentRoot = resolve(args.projectRoot, '..', 'var', 'agents', scopeAgent(args.scopeRef))
  }
  return args
}

function readValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) throw new Error(`Missing value for ${flag}`)
  return value
}

function printUsage(): void {
  console.log(
    [
      'Live Codex tmux broker debugger: attach to the tmux pane before broker.start().',
      '',
      'Usage:',
      '  bun scripts/debug-codex-tmux-live.ts [options]',
      '',
      'Options:',
      '  --scope <scopeRef>       Default: sparky@agent-spaces',
      '  --agent-root <path>      Default: ../var/agents/<agent-from-scope>',
      '  --project-root <path>    Default: cwd',
      '  --cwd <path>             Default: cwd',
      '  --prompt <text>          Optional launch prompt',
      '  --no-prompt              Start Codex without a launch prompt',
      '  --delayed-input          If compiled, remove initialInput from start and send after readiness',
      '  --timeout-ms <n>         Pane observation window after broker.start (default: 60000)',
      '  --cleanup                Kill the tmux server on exit',
      '  --no-wait                Do not pause after attach before broker.start',
      '  --manual-attach          Print attach command and wait instead of using ghostmux',
      '  --ghostmux-target <id>   Ghostty surface to split (default: focused/$GHOSTTY_SURFACE_UUID)',
      '  --help                   Show this message',
    ].join('\n')
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const tmuxBin = resolveTmuxBin()
  const ghostmuxBin = args.manualAttach ? undefined : resolveGhostmuxBin()
  const codex = resolveRealCodexBin()
  if (codex === undefined) throw new Error('real codex binary not found; set ASP_CODEX_PATH')
  if (!args.manualAttach && ghostmuxBin === undefined) {
    throw new Error(
      'ghostmux binary not found; use --manual-attach to print the tmux attach command'
    )
  }
  if (!existsSync(join(process.env['HOME'] ?? '', '.codex', 'auth.json'))) {
    throw new Error('codex auth not found at ~/.codex/auth.json')
  }

  process.env['ASP_CODEX_PATH'] = codex
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

  const marker = `LIVE_CODEX_TMUX_${Date.now().toString(36).toUpperCase()}`
  const prompt =
    args.noPrompt === true
      ? undefined
      : (args.prompt ??
        `Run the Bash command: printf '${marker}' — then reply with exactly ${marker} and nothing else.`)
  const artifactDir = join(tmpdir(), `codex-tmux-live-${marker}`)
  mkdirSync(artifactDir, { recursive: true })
  const aspHome = mkdtempSync(join(tmpdir(), 'asp-live-codex-tmux-'))
  ensureAspHomeRegistry(aspHome, args.projectRoot)

  const socketPath = join(tmpdir(), `codex-tmux-live-${process.pid}.sock`)
  const hookSocketPath = `${socketPath}.hooks`
  const sessionName = `codex-tmux-${marker}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)
  const attachCommand = `${tmuxBin} -S ${socketPath} attach-session -t ${sessionName}`

  let started = false
  let keepAlive: NodeJS.Timeout | undefined
  let ghostmuxSurfaceId: string | undefined
  try {
    await runTmux(tmuxBin, ['-S', socketPath, 'start-server'])
    const allocated = await allocatePreHrcTmuxPane({ tmuxBin, socketPath, sessionName })
    const client = createAgentSpacesClient({ aspHome }) as ReturnType<
      typeof createAgentSpacesClient
    > & { compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse> }
    const response = await client.compileRuntimePlan(
      codexInteractiveCompileRequest({
        scopeRef: args.scopeRef,
        agentRoot: args.agentRoot,
        projectRoot: args.projectRoot,
        cwd: args.cwd,
        prompt,
        marker,
        timeoutMs: args.timeoutMs,
      })
    )
    if (!response.ok) {
      throw new Error(`compileRuntimePlan failed: ${JSON.stringify(response.diagnostics)}`)
    }
    const profile = response.plan.executionProfiles.find(
      (candidate): candidate is BrokerExecutionProfile =>
        candidate.kind === 'harness-broker' && candidate.brokerDriver === 'codex-cli-tmux'
    )
    if (profile === undefined) throw new Error('compile did not emit codex-cli-tmux profile')
    const compiledStartRequest = profile.harnessInvocation.startRequest
    const delayedInput = args.delayedInput ? compiledStartRequest.initialInput : undefined
    const startRequest: InvocationStartRequest =
      args.delayedInput && delayedInput !== undefined
        ? { spec: compiledStartRequest.spec }
        : compiledStartRequest
    writeFileSync(
      join(artifactDir, 'start-request.json'),
      `${JSON.stringify(compiledStartRequest, null, 2)}\n`
    )
    writeFileSync(
      join(artifactDir, 'dispatched-start-request.json'),
      `${JSON.stringify(startRequest, null, 2)}\n`
    )

    const eventsPath = join(artifactDir, 'events.ndjson')
    const broker = createBroker({
      drivers: [
        createCodexCliTmuxDriver({
          tmux: {
            socketPath,
            tmuxBin,
            exec: (argv, execOptions) => runTmux(tmuxBin, argv.slice(1), execOptions?.env),
          },
          hooks: {
            listen: makeCodexHookListener(hookSocketPath),
            bridgeCommand: `bun ${join(args.projectRoot, 'packages/harness-broker/bin/harness-broker.js')} codex-hook`,
          },
        }),
      ],
      onEvent: (event) => {
        appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
        console.log(formatEventLogLine(event))
      },
    })

    console.log(`artifactDir: ${artifactDir}`)
    console.log(`codex:      ${codex}`)
    console.log(`tmux pane:  ${allocated.lease.paneId}`)
    console.log(`prompt:     ${prompt ?? '(none)'}`)
    const inputMode =
      delayedInput !== undefined
        ? args.delayedInput
          ? 'after pane readiness'
          : 'initialInput during start'
        : 'launch argv prompt'
    console.log(`input mode: ${inputMode}`)
    console.log(`request:    ${join(artifactDir, 'start-request.json')}`)
    console.log(`dispatch:   ${join(artifactDir, 'dispatched-start-request.json')}`)
    console.log(`attach:     ${attachCommand}`)
    if (!args.manualAttach && ghostmuxBin !== undefined) {
      ghostmuxSurfaceId = await openGhostmuxAttachPane({
        ghostmuxBin,
        attachCommand,
        cwd: args.cwd,
        target: args.ghostmuxTarget,
      })
      console.log(`ghostmux:   ${ghostmuxSurfaceId}`)
    }
    console.log('')
    if (!args.noWait) {
      const message = args.manualAttach
        ? 'Attach in another terminal now, then press Enter here to call broker.start() '
        : 'Ghostmux attach pane opened. Press Enter here to call broker.start() '
      await waitForEnter(message)
    }

    started = true
    console.log('calling broker.start(...)')
    const start = await broker.start(startRequest, undefined, {
      terminalSurface: allocated.lease,
    } satisfies InvocationRuntimeContext)
    console.log(`broker.start returned: invocationId=${start.invocationId} state=${start.state}`)

    const observed = await observePane(tmuxBin, socketPath, allocated.lease.paneId, args.timeoutMs)
    writeFileSync(join(artifactDir, 'pane-after-start.txt'), observed.pane)
    console.log(`pane status after ${args.timeoutMs}ms: ${observed.status}`)
    console.log(`pane capture: ${join(artifactDir, 'pane-after-start.txt')}`)
    if (delayedInput !== undefined) {
      if (observed.status !== 'codex-ready') {
        console.log('delayed input skipped because Codex did not reach pane readiness')
      } else {
        console.log('sending delayed broker.input(...)')
        await broker.input({
          invocationId: start.invocationId,
          input: delayedInput as InvocationInput,
          policy: { whenBusy: 'reject' },
        })
      }
    }
    console.log('')
    console.log('Keeping the broker hook listener alive. Press Ctrl-C here when done watching.')
    keepAlive = setInterval(() => undefined, 60_000)
    await new Promise<void>((resolvePromise) => {
      process.once('SIGINT', () => {
        process.stdin.pause()
        resolvePromise()
      })
    })
    writeFileSync(
      join(artifactDir, 'pane-final.txt'),
      await capturePane(tmuxBin, socketPath, allocated.lease.paneId)
    )
    await broker
      .stop({ invocationId: start.invocationId, reason: 'debugger-exit' })
      .catch(() => undefined)
    await broker.dispose({ invocationId: start.invocationId }).catch(() => undefined)
  } finally {
    if (keepAlive !== undefined) clearInterval(keepAlive)
    console.log(`final attach command: ${attachCommand}`)
    console.log(`artifacts: ${artifactDir}`)
    if (args.cleanup || !started) {
      if (ghostmuxBin !== undefined && ghostmuxSurfaceId !== undefined) {
        await runGhostmux(ghostmuxBin, ['kill-surface', '-t', ghostmuxSurfaceId]).catch(
          () => undefined
        )
      }
      await runTmux(tmuxBin, ['-S', socketPath, 'kill-server']).catch(() => undefined)
    }
  }
}

function codexInteractiveCompileRequest(input: {
  scopeRef: string
  agentRoot?: string | undefined
  projectRoot: string
  cwd: string
  prompt?: string | undefined
  marker: string
  timeoutMs: number
}): RuntimeCompileRequest {
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: 'live_codex_tmux',
    invocationId: `inv_live_codex_tmux_${input.marker}`,
    initialInputId: `input_live_codex_tmux_${input.marker}`,
    idempotencyKey: `live-codex-tmux-${input.marker}`,
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: input.scopeRef,
    agentRoot: input.agentRoot,
    projectRoot: input.projectRoot,
    cwd: input.cwd,
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
      interactionMode: 'interactive',
    },
    materialization: {
      ...(input.prompt !== undefined ? { initialPrompt: input.prompt } : {}),
      taskContext: {
        taskId: 'codex-tmux-live-debug',
        phase: 'live-debug',
        role: 'debug',
        requiredEvidenceKinds: ['tmux-pane'],
        hintsText: 'Live codex-cli-tmux broker launch debugger',
      },
    },
    hrcPolicy: {
      permissionPolicy: allowPermissionPolicy(),
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
      resourceLimits: { startupTimeoutMs: input.timeoutMs, turnTimeoutMs: input.timeoutMs },
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
      appSessionKey: `live-codex-tmux-${input.marker}`,
      scopeRef: input.scopeRef,
      laneRef: 'main',
    },
  }
}

function formatEventLogLine(event: {
  type: string
  turnId?: string | undefined
  payload?: unknown
}): string {
  const turn = event.turnId ? ` turn=${event.turnId}` : ''
  const detail = importantEventDetail(event.type, event.payload)
  return `[event] ${event.type}${turn}${detail !== undefined ? ` ${detail}` : ''}`
}

function importantEventDetail(type: string, payload: unknown): string | undefined {
  const record = asRecord(payload)
  if (type === 'turn.started') {
    const prompt = turnStartedPromptText(record)
    return prompt.length > 0 ? `prompt=${JSON.stringify(truncate(prompt, 220))}` : undefined
  }
  if (type === 'assistant.message.completed') {
    const text = assistantMessageText(record)
    return text.length > 0 ? `message=${JSON.stringify(truncate(text, 220))}` : undefined
  }
  if (type === 'tool.call.started') {
    const name = stringValue(record['name']) ?? stringValue(record['toolName']) ?? 'tool'
    const input = asRecord(record['input'])
    const command =
      stringValue(input?.['command']) ??
      stringValue(input?.['cmd']) ??
      stringValue(input?.['description']) ??
      stringValue(record['command'])
    return command !== undefined
      ? `tool=${JSON.stringify(name)} cmd=${JSON.stringify(truncate(command, 220))}`
      : `tool=${JSON.stringify(name)}`
  }
  if (type === 'turn.completed') {
    const response = turnCompletedResponseText(record)
    return response.length > 0 ? `response=${JSON.stringify(truncate(response, 220))}` : undefined
  }
  return undefined
}

function assistantMessageText(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined) return ''
  const direct =
    stringValue(payload['text']) ??
    stringValue(payload['message']) ??
    stringValue(payload['finalOutput']) ??
    stringValue(payload['lastAssistantMessage'])
  if (direct !== undefined) return direct

  const content = payload['content']
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const record = asRecord(part)
      return stringValue(record?.['text']) ?? stringValue(record?.['message']) ?? ''
    })
    .filter((part) => part.length > 0)
    .join('')
}

function turnStartedPromptText(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined) return ''
  return (
    stringValue(payload['prompt']) ??
    stringValue(payload['input']) ??
    stringValue(payload['text']) ??
    stringValue(payload['userPrompt']) ??
    ''
  )
}

function turnCompletedResponseText(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined) return ''
  return (
    stringValue(payload['finalOutput']) ??
    stringValue(payload['output']) ??
    stringValue(payload['response']) ??
    stringValue(payload['lastAssistantMessage']) ??
    ''
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

async function observePane(
  tmuxBin: string,
  socketPath: string,
  paneId: string,
  timeoutMs: number
): Promise<{ status: 'codex-ready' | 'launch-command-stuck' | 'unknown'; pane: string }> {
  const deadline = Date.now() + timeoutMs
  let latest = ''
  while (Date.now() < deadline) {
    latest = await capturePane(tmuxBin, socketPath, paneId).catch((error) =>
      error instanceof Error ? error.message : String(error)
    )
    if (latest.includes('OpenAI Codex') && latest.includes('Context') && latest.includes('›')) {
      return { status: 'codex-ready', pane: latest }
    }
    if (
      latest.includes('HARNESS_BROKER_INVOCATION_ID=') &&
      latest.includes('HRC_LAUNCH_HOOK_CLI=') &&
      latest.includes(' codex ')
    ) {
      return { status: 'launch-command-stuck', pane: latest }
    }
    await sleep(1000)
  }
  return { status: 'unknown', pane: latest }
}

function makeCodexHookListener(
  socketPath: string
): (
  handler: (envelope: unknown) => void | Promise<void>
) => Promise<{ socketPath: string; close: () => Promise<void> }> {
  return async (handler) => {
    const { mkdir, rm } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined)
    await rm(socketPath, { force: true }).catch(() => undefined)

    const server = createServer((conn) => {
      const chunks: Buffer[] = []
      conn.on('data', (chunk: Buffer) => chunks.push(chunk))
      conn.on('end', () => {
        void (async () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8').trim()
            if (body.length > 0) await handler(JSON.parse(body))
            conn.end('ok')
          } catch {
            conn.end('err')
          }
        })()
      })
    })

    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.removeListener('error', reject)
        resolvePromise()
      })
    })

    return {
      socketPath,
      close: () =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise())
        }),
    }
  }
}

function allowPermissionPolicy(): BrokerPermissionPolicy {
  return {
    mode: 'allow',
    audit: true,
    provenance: {
      source: 'test',
      requestId: 'request_live_codex_tmux',
      createdAt: new Date().toISOString(),
    },
  } as BrokerPermissionPolicy
}

async function openGhostmuxAttachPane(input: {
  ghostmuxBin: string
  attachCommand: string
  cwd: string
  target?: string | undefined
}): Promise<string> {
  const status = await runGhostmux(input.ghostmuxBin, ['status'])
  if (status.code !== 0 || !/available:\s*true/i.test(status.stdout)) {
    throw new Error(
      `ghostmux is not available; use --manual-attach to print the tmux attach command (${status.stderr.trim() || status.stdout.trim() || `exit ${status.code}`})`
    )
  }

  const newPaneArgs = [
    'new-pane',
    ...(input.target !== undefined ? ['-t', input.target] : []),
    '-d',
    'down',
    '--cwd',
    input.cwd,
    '--command',
    input.attachCommand,
    '--json',
  ]
  const created = await runGhostmux(input.ghostmuxBin, newPaneArgs)
  if (created.code !== 0) {
    throw new Error(
      `ghostmux new-pane failed: ${created.stderr.trim() || created.stdout.trim() || `exit ${created.code}`}`
    )
  }

  let parsed: { id?: string | undefined; surfaceId?: string | undefined }
  try {
    parsed = JSON.parse(created.stdout) as { id?: string | undefined; surfaceId?: string }
  } catch {
    throw new Error(`ghostmux new-pane returned non-JSON output: ${created.stdout.trim()}`)
  }
  const surfaceId = parsed.id ?? parsed.surfaceId
  if (surfaceId === undefined || surfaceId.length === 0) {
    throw new Error(`ghostmux new-pane returned no surface id: ${created.stdout.trim()}`)
  }
  return surfaceId
}

function resolveTmuxBin(): string {
  for (const candidate of [
    '/opt/homebrew/bin/tmux',
    '/opt/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return 'tmux'
}

function resolveGhostmuxBin(): string | undefined {
  for (const candidate of [
    process.env['GHOSTMUX_PATH'],
    join(process.env['HOME'] ?? '', '.local/bin/ghostmux'),
    '/opt/homebrew/bin/ghostmux',
    '/usr/local/bin/ghostmux',
    '/usr/bin/ghostmux',
  ]) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  const onPath = Bun.which('ghostmux')
  return onPath !== null && existsSync(onPath) ? onPath : undefined
}

function resolveRealCodexBin(): string | undefined {
  for (const candidate of [
    process.env['ASP_CODEX_PATH'],
    join(process.env['HOME'] ?? '', '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    ...nvmCodexCandidates(),
    join(process.env['HOME'] ?? '', '.volta/bin/codex'),
    join(process.env['HOME'] ?? '', '.asdf/shims/codex'),
  ]) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  const onPath = Bun.which('codex')
  return onPath !== null && existsSync(onPath) ? onPath : undefined
}

function nvmCodexCandidates(): string[] {
  const versionsDir = join(process.env['HOME'] ?? '', '.nvm/versions/node')
  if (!existsSync(versionsDir)) return []
  return readdirSync(versionsDir)
    .sort()
    .reverse()
    .map((version) => join(versionsDir, version, 'bin/codex'))
}

function ensureAspHomeRegistry(aspHome: string, projectRoot: string): void {
  const repoPath = join(aspHome, 'repo')
  if (existsSync(join(repoPath, 'spaces', 'defaults', 'space.toml'))) return
  if (existsSync(repoPath)) return
  for (const candidate of [
    process.env['ASP_REGISTRY'],
    process.env['ASP_HOME'] !== undefined ? join(process.env['ASP_HOME'], 'repo') : undefined,
    join(resolve(projectRoot, '..'), 'var', 'spaces-repo', 'repo'),
  ]) {
    if (
      candidate !== undefined &&
      candidate.length > 0 &&
      existsSync(join(candidate, 'spaces', 'defaults', 'space.toml'))
    ) {
      symlinkSync(candidate, repoPath, 'dir')
      return
    }
  }
}

function scopeAgent(scopeRef: string): string {
  return scopeRef.split('@')[0]?.split(':')[0] ?? scopeRef
}

function runTmux(
  tmuxBin: string,
  argv: string[],
  env: Record<string, string | undefined> = process.env
): Promise<TmuxResult> {
  return new Promise((resolvePromise, reject) => {
    const cleanEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) cleanEnv[key] = value
    }
    const proc = spawn(tmuxBin, argv, { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `tmux exited with ${code}`))
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

function runGhostmux(ghostmuxBin: string, argv: string[]): Promise<GhostmuxResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(ghostmuxBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      resolvePromise({ code: code ?? 0, stdout, stderr })
    })
  })
}

async function capturePane(tmuxBin: string, socketPath: string, paneId: string): Promise<string> {
  const result = await runTmux(tmuxBin, [
    '-S',
    socketPath,
    'capture-pane',
    '-t',
    paneId,
    '-p',
    '-S',
    '-200',
  ])
  return result.stdout
}

async function waitForEnter(message: string): Promise<void> {
  process.stdout.write(message)
  process.stdin.resume()
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = (): void => {
      process.stdin.off('data', onData)
      process.off('SIGINT', onSigint)
      process.stdin.pause()
    }
    const onData = (): void => {
      cleanup()
      resolvePromise()
    }
    const onSigint = (): void => {
      cleanup()
      reject(new Error('aborted before broker.start'))
    }
    process.stdin.once('data', onData)
    process.once('SIGINT', onSigint)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
