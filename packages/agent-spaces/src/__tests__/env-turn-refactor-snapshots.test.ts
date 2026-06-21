/**
 * Characterization snapshots for T-04601/T-04602/T-04604.
 *
 * These tests pin the delicate env-compose and turn-driver behavior that must
 * survive the F2/F3/F5 extractions. They intentionally assert the current
 * divergence between preparePlacementCliRuntime and runPlacementTurnNonInteractive:
 * CLI exposes pathPrepend and folds adapter/agentchat env into lockedEnv, while
 * placement ignores pathPrepend and omits adapter/agentchat env entirely.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { RuntimePlacement } from 'spaces-config'
import { type UnifiedSession, prepareAgentToolRuntime } from 'spaces-execution'

import { buildCorrelationEnvVars } from '../placement-api.js'
import { preparePlacementCliRuntime } from '../prepare-cli-runtime.js'
import { type InFlightRunContext, completeInFlightSuccess } from '../run-tracker.js'
import { shouldDrainOutstandingTurn } from '../run-turn-helpers.js'
import { createEventEmitter, mapUnifiedEvents } from '../session-events.js'
import type { AgentEvent } from '../types.js'

type Fixture = {
  agentRoot: string
  projectRoot: string
  aspHome: string
  codexShim: string
  toolsBin: string
  cleanup: () => void
}

class FakeSession implements UnifiedSession {
  readonly kind = 'agent-sdk'
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendPrompt(): Promise<void> {}
  onEvent(): void {}
}

const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

afterEach(() => {
  if (originalCodexPath === undefined) {
    process.env['ASP_CODEX_PATH'] = undefined
  } else {
    process.env['ASP_CODEX_PATH'] = originalCodexPath
  }
  if (originalSkipCommon === undefined) {
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
  } else {
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
  }
})

function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'asp-env-turn-snapshot-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const toolsBin = join(agentRoot, 'tools', 'bin')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  mkdirSync(toolsBin, { recursive: true })

  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2
priming_prompt = "Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}."

[spaces]
base = []

[harnessDefaults.codex]
model = "gpt-5.3-codex"
model_reasoning_effort = "medium"
approval_policy = "on-failure"
sandbox_mode = "workspace-write"
profile = "workbench"
`,
    'utf8'
  )

  const toolPath = join(toolsBin, 'snapshot-tool')
  writeFileSync(toolPath, 'echo snapshot\n', 'utf8')
  chmodSync(toolPath, 0o755)

  const codexShim = join(aspHome, 'codex')
  writeFileSync(
    codexShim,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "codex 999.0.0"
  exit 0
fi
if [[ "$1" == "app-server" && "$2" == "--help" ]]; then
  echo "app-server"
  exit 0
fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(codexShim, 0o755)

  return {
    agentRoot,
    projectRoot,
    aspHome,
    codexShim,
    toolsBin,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function createPlacement(fixture: Fixture, dryRun: boolean): RuntimePlacement {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task',
    dryRun,
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04601',
        laneRef: 'snapshots',
      },
      hostSessionId: 'host-session-04601',
    },
  }
}

function pickEnv(env: Record<string, string>): Record<string, string | undefined> {
  return {
    ADAPTER_CODEX_HOME: env['CODEX_HOME'],
    AGENTCHAT_ID: env['AGENTCHAT_ID'],
    AGENT_HOST_SESSION_ID: env['AGENT_HOST_SESSION_ID'],
    AGENT_LANE_REF: env['AGENT_LANE_REF'],
    AGENT_SCOPE_REF: env['AGENT_SCOPE_REF'],
    ASP_AGENT_CACHE_DIR: env['ASP_AGENT_CACHE_DIR'],
    ASP_AGENT_LOG_DIR: env['ASP_AGENT_LOG_DIR'],
    ASP_AGENT_NAME: env['ASP_AGENT_NAME'],
    ASP_AGENT_ROOT: env['ASP_AGENT_ROOT'],
    ASP_AGENT_STATE_DIR: env['ASP_AGENT_STATE_DIR'],
    ASP_AGENT_TOOLS_BIN: env['ASP_AGENT_TOOLS_BIN'],
    ASP_AGENT_TOOLS_DIR: env['ASP_AGENT_TOOLS_DIR'],
    ASP_AGENT_VAR_DIR: env['ASP_AGENT_VAR_DIR'],
    ASP_HOME: env['ASP_HOME'],
    ASP_PROJECT: env['ASP_PROJECT'],
    ASP_PROJECT_ID: env['ASP_PROJECT_ID'],
    ASP_PROJECT_ROOT: env['ASP_PROJECT_ROOT'],
    ASP_PROJECT_STATE_DIR: env['ASP_PROJECT_STATE_DIR'],
    LOCKED_ONLY: env['LOCKED_ONLY'],
    PATH: env['PATH'],
    REQ_ENV: env['REQ_ENV'],
    REQ_WINS: env['REQ_WINS'],
  }
}

describe('T-04601 env-compose snapshots', () => {
  test('preparePlacementCliRuntime folds adapterEnv and agentchatEnv into lockedEnv and emits pathPrepend', async () => {
    const fixture = createFixture()
    try {
      process.env['ASP_CODEX_PATH'] = fixture.codexShim
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

      const prepared = await preparePlacementCliRuntime(
        {
          placement: createPlacement(fixture, true),
          provider: 'openai',
          frontend: 'codex-cli',
          interactionMode: 'headless',
          model: 'gpt-5.3-codex',
          aspHome: fixture.aspHome,
          lockedEnv: { LOCKED_ONLY: 'locked-env', REQ_WINS: 'locked-env' },
          dispatchEnv: { DISPATCH_ONLY: 'dispatch-env' },
        },
        fixture.aspHome
      )

      expect(pickEnv(prepared.lockedEnv)).toEqual({
        ADAPTER_CODEX_HOME: join(fixture.aspHome, 'codex-homes', 'agent-spaces_cody'),
        AGENTCHAT_ID: 'cody',
        AGENT_HOST_SESSION_ID: undefined,
        AGENT_LANE_REF: undefined,
        AGENT_SCOPE_REF: undefined,
        ASP_AGENT_CACHE_DIR: join(fixture.agentRoot, 'var', 'cache'),
        ASP_AGENT_LOG_DIR: join(fixture.agentRoot, 'var', 'logs'),
        ASP_AGENT_NAME: 'cody',
        ASP_AGENT_ROOT: fixture.agentRoot,
        ASP_AGENT_STATE_DIR: join(fixture.agentRoot, 'var', 'state'),
        ASP_AGENT_TOOLS_BIN: fixture.toolsBin,
        ASP_AGENT_TOOLS_DIR: join(fixture.agentRoot, 'tools'),
        ASP_AGENT_VAR_DIR: join(fixture.agentRoot, 'var'),
        ASP_HOME: fixture.aspHome,
        ASP_PROJECT: basename(fixture.projectRoot),
        ASP_PROJECT_ID: 'agent-spaces_cody',
        ASP_PROJECT_ROOT: fixture.projectRoot,
        ASP_PROJECT_STATE_DIR: join(
          fixture.agentRoot,
          'var',
          'state',
          'projects',
          'agent-spaces_cody'
        ),
        LOCKED_ONLY: 'locked-env',
        PATH: undefined,
        REQ_ENV: undefined,
        REQ_WINS: 'locked-env',
      })
      expect(prepared.dispatchEnv).toEqual({
        AGENT_SCOPE_REF: 'agent:cody:project:agent-spaces:task:T-04601',
        AGENT_LANE_REF: 'snapshots',
        AGENT_HOST_SESSION_ID: 'host-session-04601',
        DISPATCH_ONLY: 'dispatch-env',
      })
      expect(pickEnv(prepared.env)).toEqual({
        ...pickEnv(prepared.lockedEnv),
        AGENT_HOST_SESSION_ID: 'host-session-04601',
        AGENT_LANE_REF: 'snapshots',
        AGENT_SCOPE_REF: 'agent:cody:project:agent-spaces:task:T-04601',
        PATH: expect.stringContaining(fixture.toolsBin) as unknown as string,
      })
      expect(prepared.pathPrepend).toEqual([fixture.toolsBin])
      expect(prepared.warnings).toEqual([
        'Agent tool "snapshot-tool" is executable text but has no shebang',
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test('placement turn env omits adapterEnv and agentchatEnv, ignores pathPrepend', async () => {
    const fixture = createFixture()
    try {
      const placement = createPlacement(fixture, true)
      const lockedEnv: Record<string, string> = {
        REQ_ENV: 'request-env',
        REQ_WINS: 'locked-env',
        LOCKED_ONLY: 'locked-env',
      }
      const dispatchEnv = {
        ...buildCorrelationEnvVars(placement),
        DISPATCH_ONLY: 'dispatch-env',
      }
      const harnessEnv: Record<string, string> = { ...lockedEnv, ...dispatchEnv }
      lockedEnv['ASP_HOME'] = fixture.aspHome
      harnessEnv['ASP_HOME'] = fixture.aspHome

      const toolRuntime = await prepareAgentToolRuntime(
        {
          agentRoot: fixture.agentRoot,
          projectRoot: fixture.projectRoot,
          components: {
            agentRoot: fixture.agentRoot,
            agentName: 'cody',
            hasSkills: false,
            hasCommands: false,
            hasTools: true,
            skillsDir: join(fixture.agentRoot, 'skills'),
            commandsDir: join(fixture.agentRoot, 'commands'),
            toolsDir: join(fixture.agentRoot, 'tools'),
            toolsBinDir: fixture.toolsBin,
            agentVarDir: join(fixture.agentRoot, 'var'),
          },
        },
        harnessEnv
      )
      const { PATH: _toolPath, ...toolLockedEnv } = toolRuntime.env
      Object.assign(lockedEnv, toolLockedEnv)
      Object.assign(harnessEnv, toolRuntime.env)

      expect(pickEnv(lockedEnv)).toEqual({
        ADAPTER_CODEX_HOME: undefined,
        AGENTCHAT_ID: undefined,
        AGENT_HOST_SESSION_ID: undefined,
        AGENT_LANE_REF: undefined,
        AGENT_SCOPE_REF: undefined,
        ASP_AGENT_CACHE_DIR: join(fixture.agentRoot, 'var', 'cache'),
        ASP_AGENT_LOG_DIR: join(fixture.agentRoot, 'var', 'logs'),
        ASP_AGENT_NAME: 'cody',
        ASP_AGENT_ROOT: fixture.agentRoot,
        ASP_AGENT_STATE_DIR: join(fixture.agentRoot, 'var', 'state'),
        ASP_AGENT_TOOLS_BIN: fixture.toolsBin,
        ASP_AGENT_TOOLS_DIR: join(fixture.agentRoot, 'tools'),
        ASP_AGENT_VAR_DIR: join(fixture.agentRoot, 'var'),
        ASP_HOME: fixture.aspHome,
        ASP_PROJECT: undefined,
        ASP_PROJECT_ID: 'agent-spaces_cody',
        ASP_PROJECT_ROOT: fixture.projectRoot,
        ASP_PROJECT_STATE_DIR: join(
          fixture.agentRoot,
          'var',
          'state',
          'projects',
          'agent-spaces_cody'
        ),
        LOCKED_ONLY: 'locked-env',
        PATH: undefined,
        REQ_ENV: 'request-env',
        REQ_WINS: 'locked-env',
      })
      expect(dispatchEnv).toEqual({
        AGENT_SCOPE_REF: 'agent:cody:project:agent-spaces:task:T-04601',
        AGENT_LANE_REF: 'snapshots',
        AGENT_HOST_SESSION_ID: 'host-session-04601',
        DISPATCH_ONLY: 'dispatch-env',
      })
      expect(pickEnv(harnessEnv)).toEqual({
        ...pickEnv(lockedEnv),
        AGENT_HOST_SESSION_ID: 'host-session-04601',
        AGENT_LANE_REF: 'snapshots',
        AGENT_SCOPE_REF: 'agent:cody:project:agent-spaces:task:T-04601',
        PATH: expect.stringContaining(fixture.toolsBin) as unknown as string,
      })
      expect(toolRuntime.pathPrepend).toEqual([fixture.toolsBin])
      expect(toolRuntime.warnings).toEqual([
        'Agent tool "snapshot-tool" is executable text but has no shebang',
      ])
    } finally {
      fixture.cleanup()
    }
  })
})

describe('T-04602 turn-driver loop snapshots', () => {
  test('in-flight outstanding-turn drain waits for all pending turns before completing', async () => {
    const emitted: AgentEvent[] = []
    const eventEmitter = createEventEmitter((event) => emitted.push(event), {
      hostSessionId: 'host-inflight',
      runId: 'run-inflight',
    })
    const context: InFlightRunContext = {
      hostSessionId: 'host-inflight',
      runId: 'run-inflight',
      provider: 'anthropic',
      frontend: 'agent-sdk',
      model: 'claude-opus-4.1',
      session: new FakeSession(),
      eventEmitter,
      assistantState: { assistantBuffer: '' },
      allowSessionIdUpdate: true,
      outstandingTurns: 2,
      acceptedInputApplicationIds: new Set(),
      started: Promise.resolve(),
      completion: { done: false, resolve: () => {}, reject: () => {} },
      sendChain: Promise.resolve(),
    }

    const continuationKeys: string[] = []
    const agentStart = mapUnifiedEvents(
      { type: 'agent_start', sessionId: 'sdk-session-1' },
      (event) => void eventEmitter.emit(event),
      (key) => {
        continuationKeys.push(key)
        context.continuationKey = key
        eventEmitter.setContinuation({ provider: context.provider, key })
      },
      context.assistantState,
      { allowSessionIdUpdate: context.allowSessionIdUpdate }
    )
    expect(agentStart.turnEnded).toBe(false)
    expect(continuationKeys).toEqual(['sdk-session-1'])

    const firstTurnEnd = mapUnifiedEvents(
      { type: 'turn_end' },
      (event) => void eventEmitter.emit(event),
      () => {},
      context.assistantState,
      { allowSessionIdUpdate: true }
    )
    expect(shouldDrainOutstandingTurn({ type: 'turn_end' }, firstTurnEnd, context)).toBe(true)
    context.outstandingTurns = Math.max(0, context.outstandingTurns - 1)
    expect(context.outstandingTurns).toBe(1)
    expect(context.completion.done).toBe(false)

    mapUnifiedEvents(
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
      },
      (event) => void eventEmitter.emit(event),
      () => {},
      context.assistantState,
      { allowSessionIdUpdate: true }
    )
    const secondTurnEnd = mapUnifiedEvents(
      { type: 'turn_end' },
      (event) => void eventEmitter.emit(event),
      () => {},
      context.assistantState,
      { allowSessionIdUpdate: true }
    )
    expect(shouldDrainOutstandingTurn({ type: 'turn_end' }, secondTurnEnd, context)).toBe(true)
    context.outstandingTurns = Math.max(0, context.outstandingTurns - 1)
    expect(context.outstandingTurns).toBe(0)

    const response = await completeInFlightSuccess(context)
    await eventEmitter.idle()
    expect(response.continuation).toEqual({ provider: 'anthropic', key: 'sdk-session-1' })
    expect(response.result).toEqual({ success: true, finalOutput: 'final answer' })
    expect(emitted.map((event) => event.type)).toEqual(['message', 'state', 'complete'])
    expect(emitted.map((event) => event.seq)).toEqual([1, 2, 3])
  })

  test('non-inflight turnEnded boolean completes once and preserves continuation capture', async () => {
    const emitted: AgentEvent[] = []
    const eventEmitter = createEventEmitter((event) => emitted.push(event), {
      hostSessionId: 'host-non-inflight',
      runId: 'run-non-inflight',
    })
    const assistantState = { assistantBuffer: '' }
    let continuationKey: string | undefined
    let turnEnded = false
    let completions = 0

    const handle = (event: Parameters<typeof mapUnifiedEvents>[0]): void => {
      const result = mapUnifiedEvents(
        event,
        (mapped) => void eventEmitter.emit(mapped),
        (key) => {
          continuationKey = key
          eventEmitter.setContinuation({ provider: 'anthropic', key })
        },
        assistantState,
        { allowSessionIdUpdate: true }
      )
      if (result.turnEnded && !turnEnded) {
        turnEnded = true
        completions += 1
      }
    }

    handle({ type: 'sdk_session_id', sdkSessionId: 'sdk-session-2' })
    handle({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done once' }] },
    })
    handle({ type: 'turn_end' })
    handle({ type: 'turn_end' })
    await eventEmitter.idle()

    expect(continuationKey).toBe('sdk-session-2')
    expect(assistantState.lastAssistantText).toBe('done once')
    expect(completions).toBe(1)
    expect(emitted.map((event) => event.type)).toEqual(['message'])
    expect(emitted[0]?.continuation).toEqual({ provider: 'anthropic', key: 'sdk-session-2' })
  })

  test('placement in-flight drain disables pi-sdk continuation updates and empty-response gate fails with no assistant content', async () => {
    const emitted: AgentEvent[] = []
    const eventEmitter = createEventEmitter((event) => emitted.push(event), {
      hostSessionId: 'host-placement',
      runId: 'run-placement',
    })
    const context: InFlightRunContext = {
      hostSessionId: 'host-placement',
      runId: 'run-placement',
      provider: 'openai',
      frontend: 'pi-sdk',
      model: 'gpt-5.3-codex',
      session: new FakeSession(),
      eventEmitter,
      assistantState: { assistantBuffer: '' },
      allowSessionIdUpdate: false,
      outstandingTurns: 1,
      acceptedInputApplicationIds: new Set(),
      started: Promise.resolve(),
      completion: { done: false, resolve: () => {}, reject: () => {} },
      sendChain: Promise.resolve(),
    }
    let continuationKey: string | undefined

    const startResult = mapUnifiedEvents(
      { type: 'agent_start', sessionId: 'ignored-pi-sdk-session' },
      (event) => void eventEmitter.emit(event),
      (key) => {
        continuationKey = key
        context.continuationKey = key
      },
      context.assistantState,
      { allowSessionIdUpdate: context.allowSessionIdUpdate }
    )
    expect(startResult.turnEnded).toBe(false)
    expect(continuationKey).toBeUndefined()

    const turnEnd = mapUnifiedEvents(
      { type: 'turn_end' },
      (event) => void eventEmitter.emit(event),
      () => {},
      context.assistantState,
      { allowSessionIdUpdate: false }
    )
    expect(shouldDrainOutstandingTurn({ type: 'turn_end' }, turnEnd, context)).toBe(true)
    context.outstandingTurns = Math.max(0, context.outstandingTurns - 1)
    expect(context.outstandingTurns).toBe(0)

    const producedContent =
      (context.assistantState.lastAssistantText !== undefined &&
        context.assistantState.lastAssistantText.length > 0) ||
      context.assistantState.assistantBuffer.length > 0
    expect(producedContent).toBe(false)
    expect(emitted).toEqual([])
  })
})
