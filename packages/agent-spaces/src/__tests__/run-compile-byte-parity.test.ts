/**
 * Byte-parity: compiler-produced foreground launch shape (argv + composed env)
 * MUST equal the legacy `asp run` adapter path (executeHarnessRun) for the same
 * target/options — for claude-code AND codex.
 *
 * This is the gate for T-01638 Path 1 (T-01652 Phase 3): the compiler becomes
 * the single source of truth for the launch shape, so it must reproduce exactly
 * what the legacy adapter path produces. The diff between the two launch shapes
 * (argv array + env key→value map, order-normalized) MUST be empty.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type RunResult, displayPrompts, run } from 'spaces-execution'
import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  HarnessFamily,
  HarnessRuntime,
  ProviderDomain,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import {
  createAgentSpacesClient,
  createCompileRuntimeFn,
  foregroundLaunchFromResponse,
} from '../index.js'
import type { AgentSpacesClient } from '../types.js'

type CompileClient = AgentSpacesClient & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

const AGENT_NAME = 'parityagent'

function shim(path: string, body: string): string {
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function createFixture(): {
  agentRoot: string
  agentsRoot: string
  projectRoot: string
  aspHome: string
  claudePath: string
  codexPath: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-run-compile-parity-'))
  const agentsRoot = join(base, 'agents')
  const agentRoot = join(agentsRoot, AGENT_NAME)
  const projectRoot = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })

  // Agent profile with empty compose, brain disabled, no system prompt material
  // so the launch shape stays minimal and the expansion context cannot diverge.
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

  // asp-targets.toml declaring the agent target (empty compose).
  writeFileSync(
    join(projectRoot, 'asp-targets.toml'),
    `schema = 1

[targets.${AGENT_NAME}]
compose = []
remote_control = true
`,
    'utf8'
  )

  const claudePath = shim(
    join(aspHome, 'claude'),
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "claude 1.0.0"; exit 0; fi
echo "claude shim"
`
  )
  const codexPath = shim(
    join(aspHome, 'codex'),
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "codex 999.0.0"; exit 0; fi
if [[ "$1" == "app-server" && "$2" == "--help" ]]; then echo "app-server"; exit 0; fi
echo "codex shim"
`
  )

  return {
    agentRoot,
    agentsRoot,
    projectRoot,
    aspHome,
    claudePath,
    codexPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

let fixture: ReturnType<typeof createFixture>

const savedEnv: Record<string, string | undefined> = {}
function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key]
  process.env[key] = value
}
function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function createClient(): CompileClient {
  return createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
}

interface HarnessCase {
  harness: 'claude' | 'codex'
  provider: ProviderDomain
  family: HarnessFamily
  runtime: HarnessRuntime
  model?: string | undefined
}

const CASES: HarnessCase[] = [
  {
    harness: 'claude',
    provider: 'anthropic',
    family: 'claude-code',
    runtime: 'claude-code-cli',
    model: 'claude-sonnet-4-5',
  },
  {
    harness: 'codex',
    provider: 'openai',
    family: 'codex',
    runtime: 'codex-cli',
  },
]

function compileRequest(
  testCase: HarnessCase,
  controllerIntent?: 'foreground-terminal'
): RuntimeCompileRequest {
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity: {
      requestId: 'request_parity',
      operationId: 'runtimeOperation_parity',
      hostSessionId: 'hostSession_parity',
      generation: 1,
      runtimeId: 'runtime_parity',
      invocationId: 'inv_parity' as InvocationId,
      initialInputId: 'input_parity' as InputId,
      runId: 'run_parity',
      traceId: 'trace_parity',
      idempotencyKey: 'run-compile-byte-parity',
    },
    placement: {
      agentRoot: fixture.agentRoot,
      projectRoot: fixture.projectRoot,
      cwd: fixture.projectRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: AGENT_NAME, projectRoot: fixture.projectRoot },
      correlation: {
        sessionRef: {
          scopeRef: `agent:${AGENT_NAME}:project:project:task:primary`,
          laneRef: 'main',
        },
        hostSessionId: 'hostSession_parity',
      },
    },
    requested: {
      modelProvider: testCase.provider,
      ...(testCase.model !== undefined ? { model: testCase.model } : {}),
      harnessFamily: testCase.family,
      preferredHarnessRuntime: testCase.runtime,
      interactionMode: 'interactive',
      ...(controllerIntent !== undefined ? { controllerIntent } : {}),
    } as unknown as RuntimeCompileRequest['requested'],
    materialization: {
      taskContext: {
        taskId: 'primary',
        phase: null,
        role: 'asp-run',
        requiredEvidenceKinds: [],
        hintsText: '',
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
    },
    correlation: {
      requestId: 'request_parity',
      operationId: 'runtimeOperation_parity',
      hostSessionId: 'hostSession_parity',
      generation: 1,
      runtimeId: 'runtime_parity',
      runId: 'run_parity',
      invocationId: 'inv_parity' as InvocationId,
      traceId: 'trace_parity',
      appId: 'agent-spaces-tests',
      appSessionKey: 'run-compile-byte-parity',
    },
  }
}

function brokerProfile(response: RuntimeCompileResponse): BrokerExecutionProfile {
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error(
      `compileRuntimePlan failed: ${response.diagnostics.map((diagnostic) => diagnostic.code).join(', ')}`
    )
  }
  const profiles = response.plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

/**
 * Canonicalize the materialized-bundle-root segment of a path.
 *
 * `asp run` installs the project target to projects/<hash(projectRoot)>/targets/<agentName>,
 * while the compiler's placement materialization writes the same composed
 * content to a synthesized location (projects/<hash>/targets/{placement-empty,spaces-<hash>}).
 * Same content, different cache location. We normalize that segment so the diff
 * surfaces real launch-shape differences (flags, flag values, env keys) rather
 * than the (tracked, follow-up) materialization-location divergence.
 */
function normalizeBundleRoot(value: string): string {
  return value.replace(/\/projects\/[^/]+\/targets\/[^/]+\//g, '/projects/<P>/targets/<T>/')
}

function normalizeGeneratedSessionIds(value: string): string {
  return value.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    '<session-id>'
  )
}

function normalizeArgv(argv: string[]): string[] {
  return argv.map((arg) => normalizeGeneratedSessionIds(normalizeBundleRoot(arg)))
}

function normalizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = normalizeBundleRoot(value)
  }
  return out
}

function settingPathBeforeSeparator(args: string[]): string {
  const separatorIndex = args.indexOf('--')
  const effectiveArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex)
  const settingsIndex = effectiveArgs.indexOf('--settings')
  expect(settingsIndex).toBeGreaterThanOrEqual(0)
  const value = effectiveArgs[settingsIndex + 1]
  if (value === undefined) throw new Error('missing --settings value')
  return value
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Capture the exact startup render displayPrompts emits for a run result. */
async function renderStartup(result: RunResult): Promise<string> {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  ;(process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    await displayPrompts({
      systemPrompt: result.systemPrompt,
      systemPromptMode: result.systemPromptMode,
      reminderContent: result.reminderContent,
      primingPrompt: result.primingPrompt,
      promptSectionSizes: result.promptSectionSizes,
      reminderSectionSizes: result.reminderSectionSizes,
      totalContextChars: result.totalContextChars,
      maxChars: result.maxChars,
      nearMaxChars: result.nearMaxChars,
      command: result.displayCommand ?? result.command,
      showCommand: true,
    })
  } finally {
    ;(process.stdout as unknown as { write: typeof original }).write = original
  }
  return chunks.join('')
}

const COMMAND_MARKER = '── command ──'

/** Framed prompt sections (system / reminder / priming) — everything before the command line. */
function renderSections(render: string): string {
  const idx = render.indexOf(COMMAND_MARKER)
  return idx === -1 ? render : render.slice(0, idx)
}

/**
 * The command line as a normalized token multiset: bundle-root canonicalized,
 * ASP_HOME assignment dropped (the documented compiler-only addition), env-prefix
 * order canonicalized (insertion order is incidental). Token ORDER of argv is
 * asserted exactly by the byte-parity test above.
 */
function canonicalCommandTokens(render: string): string[] {
  const idx = render.indexOf(COMMAND_MARKER)
  if (idx === -1) return []
  const commandLine = render.slice(idx + COMMAND_MARKER.length).trim()
  return normalizeGeneratedSessionIds(normalizeBundleRoot(commandLine))
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith('ASP_HOME='))
    .sort()
}

describe('asp run <-> compiler foreground byte-parity', () => {
  beforeAll(() => {
    fixture = createFixture()
    setEnv('ASP_AGENTS_ROOT', fixture.agentsRoot)
    setEnv('ASP_CLAUDE_PATH', fixture.claudePath)
    setEnv('ASP_CODEX_PATH', fixture.codexPath)
    setEnv('ASP_CODEX_SKIP_COMMON_PATHS', '1')
  })

  afterAll(() => {
    restoreEnv()
    fixture.cleanup()
  })

  for (const testCase of CASES) {
    test(`${testCase.harness}: compiler argv + env == legacy launch shape`, async () => {
      // Legacy adapter path (dry-run avoids spawning the harness).
      const legacy = await run(AGENT_NAME, {
        projectPath: fixture.projectRoot,
        aspHome: fixture.aspHome,
        harness: testCase.harness,
        ...(testCase.model !== undefined ? { model: testCase.model } : {}),
        interactive: true,
        dryRun: true,
      })
      expect(legacy.launch).toBeDefined()
      const legacyLaunch = legacy.launch!

      // Compiler foreground path.
      const response = await createClient().compileRuntimePlan(
        compileRequest(testCase, 'foreground-terminal')
      )
      const foreground = foregroundLaunchFromResponse(response)
      if (!foreground) {
        throw new Error(
          `compileRuntimePlan produced no foreground launch: ${
            response.ok
              ? 'ok but no terminal profile'
              : response.diagnostics.map((d) => d.code).join(', ')
          }`
        )
      }

      const compiledArgv = [foreground.command, ...foreground.args]
      const legacyArgv = [legacyLaunch.command, ...legacyLaunch.args]

      if (testCase.harness === 'claude') {
        // Regression guard (T-01652): the compiler MUST re-emit the remote-control
        // launch flags the legacy adapter produces from target.remote_control.
        expect(compiledArgv).toContain('--remote-control')
        expect(compiledArgv).toContain('--remote-control-session-name-prefix')
        expect(compiledArgv).toContain('--name')
        // The session-name VALUE (`<targetName>-<project>-<task>`) is a launch-shape value
        // and must match legacy exactly (NOT the materialized cache-dir name).
        expect(compiledArgv).toContain('parityagent-project-primary')
        // Every legacy argv element is present, modulo the materialized bundle-root
        // path segment (the accepted, separately-tracked convergence follow-up that
        // line 341 also normalizes) — same normalization the byte-parity diff uses.
        expect(normalizeArgv(compiledArgv)).toEqual(
          expect.arrayContaining(normalizeArgv(legacyArgv))
        )
      }

      // argv: byte-identical modulo the materialized-bundle-root segment.
      expect(normalizeArgv(compiledArgv)).toEqual(normalizeArgv(legacyArgv))

      // env: every key the legacy path sets is present with the same (normalized)
      // value; the compiler additionally sets ASP_HOME explicitly (legacy inherits
      // it from the ambient environment), which is the ONLY extra key.
      const compiledEnv = normalizeEnv(foreground.env)
      const legacyEnv = normalizeEnv(legacyLaunch.env)
      const extraKeys = Object.keys(compiledEnv).filter((key) => !(key in legacyEnv))
      expect(extraKeys.sort()).toEqual(['ASP_HOME'])
      expect(foreground.env['ASP_HOME']).toBe(fixture.aspHome)
      for (const [key, value] of Object.entries(legacyEnv)) {
        expect(compiledEnv[key]).toBe(value)
      }
    })

    test(`${testCase.harness}: startup render is identical legacy vs via-compiler`, async () => {
      const prompt = 'hello-foreground-parity'
      const runOnce = () =>
        run(AGENT_NAME, {
          projectPath: fixture.projectRoot,
          aspHome: fixture.aspHome,
          harness: testCase.harness,
          ...(testCase.model !== undefined ? { model: testCase.model } : {}),
          interactive: true,
          dryRun: true,
          prompt,
          compileRuntime: createCompileRuntimeFn(fixture.aspHome),
        })

      // Legacy path (gate off) vs via-compiler path (gate on).
      const legacy = await runOnce()
      process.env['ASP_RUN_VIA_COMPILER'] = '1'
      let compiled: RunResult
      try {
        compiled = await runOnce()
      } finally {
        Reflect.deleteProperty(process.env, 'ASP_RUN_VIA_COMPILER')
      }

      // The via-compiler run actually used the compiled launch shape.
      expect(compiled.runtimeCompile).toBeDefined()

      const legacyRender = await renderStartup(legacy)
      const compiledRender = await renderStartup(compiled)

      // Framed prompt sections (system / reminder / priming) byte-identical.
      expect(renderSections(compiledRender)).toBe(renderSections(legacyRender))
      // Command line identical modulo bundle-root + ASP_HOME + env-prefix order.
      expect(canonicalCommandTokens(compiledRender)).toEqual(canonicalCommandTokens(legacyRender))
    })
  }

  test('claude: tmux broker preserves durable settings while the priming rides the launch argv positional', async () => {
    const testCase = CASES.find((candidate) => candidate.harness === 'claude')
    if (testCase === undefined) throw new Error('missing claude parity case')
    const prompt = 'hello-tmux-invariant'
    const foregroundReq = compileRequest(testCase, 'foreground-terminal')
    foregroundReq.materialization = { initialPrompt: prompt }
    const foregroundResponse = await createClient().compileRuntimePlan(foregroundReq)
    const foreground = foregroundLaunchFromResponse(foregroundResponse)
    if (!foreground) {
      throw new Error(
        `compileRuntimePlan produced no foreground launch: ${
          foregroundResponse.ok
            ? 'ok but no terminal profile'
            : foregroundResponse.diagnostics.map((d) => d.code).join(', ')
        }`
      )
    }

    const brokerReq = compileRequest(testCase)
    brokerReq.materialization = { initialPrompt: prompt }
    const broker = brokerProfile(await createClient().compileRuntimePlan(brokerReq))
    const brokerProcess = broker.harnessInvocation.startRequest.spec.process
    const brokerSettingsPath = settingPathBeforeSeparator(brokerProcess.args)
    const foregroundSettings = readSettings(settingPathBeforeSeparator(foreground.args))
    const durableBrokerSettings = readSettings(brokerSettingsPath)

    expect(broker.interactionMode).toBe('interactive')
    expect(broker.brokerDriver).toBe('claude-code-tmux')
    expect(brokerProcess.harnessTransport).toEqual({ kind: 'pty' })
    expect(durableBrokerSettings['statusLine']).toEqual(foregroundSettings['statusLine'])
    expect(brokerProcess.cwd).toBe(foreground.cwd)
    expect(normalizeEnv(brokerProcess.lockedEnv ?? {})).toEqual(normalizeEnv(foreground.env))
    expect(brokerProcess.pathPrepend ?? []).toEqual([])

    const { createClaudeCodeTmuxDriver } = await import(
      '../../../harness-broker/src/drivers/claude-code-tmux/driver'
    )
    const tmuxArgv: string[][] = []
    // T-01725 Phase C: the driver consumes a pane lease — synthesize one with
    // valid tmux id shapes ($N session, @N window, %N pane) and answer the
    // driver's inspect() probe (`display-message`) with matching identifiers
    // so the leased pane integrity check passes.
    const leaseSocketPath = '/tmp/preallocated/run-compile-byte-parity.sock'
    const leaseSessionId = '$1'
    const leaseWindowId = '@1'
    const leasePaneId = '%7'
    let pendingLine = ''
    const driver = createClaudeCodeTmuxDriver({
      tmux: {
        socketPath: leaseSocketPath,
        tmuxBin: '/opt/bin/tmux',
        exec: async (argv) => {
          tmuxArgv.push([...argv])
          if (argv.includes('display-message')) {
            return {
              stdout: `${leaseSessionId}\t${leaseWindowId}\t${leasePaneId}\n`,
              stderr: '',
            }
          }
          if (argv.includes('set-buffer')) {
            pendingLine = argv.at(-1) ?? ''
            return { stdout: '', stderr: '' }
          }
          if (argv.includes('capture-pane')) {
            return { stdout: pendingLine, stderr: '' }
          }
          if (argv.includes('send-keys') && argv.includes('Enter')) {
            pendingLine = ''
            return { stdout: '', stderr: '' }
          }
          return { stdout: '', stderr: '' }
        },
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/preallocated/run-compile-byte-parity.hooks.sock',
          close: async () => undefined,
        }),
      },
      now: () => new Date('2026-05-26T18:00:00.000Z'),
    })

    await driver.start(broker.harnessInvocation.startRequest.spec, {
      invocationId: 'inv_parity',
      clientCapabilities: {},
      runtime: {
        terminalSurface: {
          kind: 'tmux-pane',
          ownership: 'hrc',
          socketPath: leaseSocketPath,
          sessionId: leaseSessionId,
          windowId: leaseWindowId,
          paneId: leasePaneId,
          sessionName: 'hrc-host-sessio',
          windowName: 'main',
          allowedOps: {
            inspect: true,
            sendInput: true,
            sendInterrupt: true,
            capture: true,
            resize: false,
          },
        },
      },
      emit: () => undefined,
    } as never)

    // T-01746: the driver now sends `exec bun <…/tmux-launch-runner> --launch-file
    // <…>.launch.json` via the paste-confirm path. The actual command line — including
    // `--settings <durable>` and the merged hook overlay — lives in the JSON
    // launch artifact's `argv`, not in the staged tmux command text.
    const launchCommandLine = tmuxArgv
      .filter((argv) => argv.includes('set-buffer'))
      .map((argv) => argv.at(-1) ?? '')
      .find((text) => /^exec bun \S*tmux-launch-runner\.(ts|js) --launch-file \S+$/.test(text))
    if (launchCommandLine === undefined) throw new Error('tmux launch command was not staged')
    const launchFilePath = launchCommandLine.replace(/^.*--launch-file /, '')
    const launchArtifact = JSON.parse(readFileSync(launchFilePath, 'utf8')) as { argv: string[] }
    const launchCommand = launchArtifact.argv.join(' ')

    expect(launchCommand).toContain(brokerProcess.command)
    const promptSeparator = ` -- ${prompt}`
    const preSeparatorLaunch = launchCommand.includes(promptSeparator)
      ? launchCommand.slice(0, launchCommand.indexOf(promptSeparator))
      : launchCommand
    const launchSettingsPaths = [...preSeparatorLaunch.matchAll(/--settings (\S+)/g)].map(
      (match) => match[1]
    )
    expect(launchSettingsPaths).toHaveLength(1)
    const effectiveSettings = readSettings(launchSettingsPaths[0] ?? '')
    expect(effectiveSettings['statusLine']).toEqual(foregroundSettings['statusLine'])
    expect(effectiveSettings['hooks']).toBeDefined()
    expect(JSON.stringify(effectiveSettings['hooks'])).toContain(
      'harness-broker claude-hook --socket /tmp/preallocated/run-compile-byte-parity.hooks.sock'
    )
    // T-01746: the priming rides the launch argv as the post-separator positional
    // (delivered to claude at launch, not typed), while settings/hooks stay
    // pre-separator. Confirm the positional priming IS present.
    expect(launchCommand).toContain(promptSeparator)
  })
})
