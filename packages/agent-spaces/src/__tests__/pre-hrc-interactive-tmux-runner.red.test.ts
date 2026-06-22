import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import {
  type InteractiveTmuxManager,
  type InteractiveTmuxRunnerDeps,
  runInteractiveClaudeTmuxSession,
} from '../testing/pre-hrc-interactive-tmux-runner.js'

const REPO_ROOT = new URL('../../../..', import.meta.url).pathname
const PROJECT_ROOT = REPO_ROOT
const AGENT_ROOT = '/Users/lherron/praesidium/var/agents/smokey'

function fakeTmuxBin(dir: string): string {
  const tmux = join(dir, 'tmux')
  writeFileSync(
    tmux,
    `#!/usr/bin/env bash
if [[ "$*" == *"new-session"* ]]; then
  printf '#1\t@1\t%%1\tzsh\n'
fi
exit 0
`,
    'utf8'
  )
  chmodSync(tmux, 0o755)
  return tmux
}

function asPayloadContent(event: InvocationEventEnvelope): string | undefined {
  const payload = event.payload as { content?: unknown } | undefined
  return typeof payload?.content === 'string' ? payload.content : undefined
}

function runnerDeps(): {
  deps: InteractiveTmuxRunnerDeps
  getStartSpec: () => HarnessInvocationSpec | undefined
} {
  let onEvent: ((event: InvocationEventEnvelope) => void) | undefined
  let startSpec: HarnessInvocationSpec | undefined
  let seq = 0

  const emit = (event: Omit<InvocationEventEnvelope, 'seq' | 'time'>): void => {
    seq += 1
    onEvent?.({
      seq,
      time: `2026-06-22T00:00:${String(seq).padStart(2, '0')}.000Z`,
      ...event,
    } as InvocationEventEnvelope)
  }

  const deps: InteractiveTmuxRunnerDeps = {
    createClaudeCodeTmuxDriver: () => ({}),
    createInvocationEventSequencer: () => ({}),
    parseDispatchEnv: (input) => input as Record<string, string>,
    createInvocationManager: (config) => {
      onEvent = config.onEvent
      const manager: InteractiveTmuxManager = {
        async start(spec) {
          startSpec = spec
          emit({
            invocationId: spec.invocationId,
            type: 'invocation.started',
            payload: { command: spec.process.command, args: spec.process.args },
          })
          emit({
            invocationId: spec.invocationId,
            type: 'terminal.surface.reported',
            payload: { socketPath: '/tmp/red.sock', sessionName: 'red', paneId: '%1' },
          })

          // Red-test context: real Claude submits the launch priming prompt as a
          // structured UserPromptSubmit. The first scenario prompt must not be
          // used as that priming, or it is indistinguishable from turn 1.
          if (typeof spec.launch?.initialPrompt === 'string') {
            emit({
              invocationId: spec.invocationId,
              type: 'user.message',
              driver: { kind: 'claude-code-tmux', rawType: 'UserPromptSubmit' },
              payload: { content: spec.launch.initialPrompt },
            })
          }
          return { invocationId: spec.invocationId }
        },
        async input(request) {
          const prompt = request.input.content[0]?.text ?? ''
          const turnId = `turn_${seq + 1}`
          emit({
            invocationId: request.invocationId,
            turnId,
            type: 'turn.started',
            driver: { kind: 'claude-code-tmux', rawType: 'UserPromptSubmit' },
            payload: { source: 'broker-delivery', turnId },
          })
          emit({
            invocationId: request.invocationId,
            turnId,
            type: 'user.message',
            driver: { kind: 'claude-code-tmux', rawType: 'UserPromptSubmit' },
            payload: { content: prompt },
          })
          if (prompt === 'T-04797 first scenario prompt') {
            emit({
              invocationId: request.invocationId,
              turnId,
              type: 'user.message',
              driver: { kind: 'claude-code-tmux', rawType: 'queue-operation' },
              payload: { content: prompt },
            })
          }
          emit({
            invocationId: request.invocationId,
            turnId,
            type: 'turn.completed',
            payload: { finalOutput: 'ok' },
          })
          return { turnId }
        },
        async stop() {
          return {}
        },
        async dispose() {
          return {}
        },
      }
      return manager
    },
  }

  return { deps, getStartSpec: () => startSpec }
}

test('pre-HRC interactive Claude tmux runner keeps launch priming separate from scripted turn 1 and counts only UserPromptSubmit duplicates', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'asp-prehrc-runner-red-'))
  try {
    const firstPrompt = 'T-04797 first scenario prompt'
    const { deps, getStartSpec } = runnerDeps()
    const output = await runInteractiveClaudeTmuxSession(
      {
        repoRoot: REPO_ROOT,
        scopeRef: 'smokey@agent-spaces',
        agentRoot: AGENT_ROOT,
        projectRoot: PROJECT_ROOT,
        cwd: PROJECT_ROOT,
        aspHome: join(tmp, 'asp-home'),
        artifactDir: join(tmp, 'artifacts'),
        socketPath: join(tmp, 'tmux.sock'),
        tmuxBin: fakeTmuxBin(tmp),
        model: 'claude-sonnet-4-5',
        prompts: [firstPrompt, 'T-04797 second scenario prompt'],
        bootWaitMs: 0,
        turnTimeoutMs: 1_000,
        keepAlive: true,
        mockClaude: false,
        anthropicKeySource: 'inherit',
        invocationId: 'inv_T04797_red',
        initialInputId: 'input_T04797_red',
        idempotencyKey: 'T-04797-red-runner',
      },
      deps
    )

    const launchPrompt = getStartSpec()?.launch?.initialPrompt
    expect(launchPrompt).toBeString()
    expect(launchPrompt).not.toBe(firstPrompt)

    const firstPromptStructuredSubmits = output.events.filter(
      (event) =>
        event.type === 'user.message' &&
        event.driver?.rawType === 'UserPromptSubmit' &&
        asPayloadContent(event) === firstPrompt
    )
    const firstPromptQueueOperations = output.events.filter(
      (event) =>
        event.type === 'user.message' &&
        event.driver?.rawType === 'queue-operation' &&
        asPayloadContent(event) === firstPrompt
    )

    expect(firstPromptStructuredSubmits).toHaveLength(1)
    expect(firstPromptQueueOperations).toHaveLength(1)
    expect(output.result.turns[0]).toMatchObject({ index: 1, prompt: firstPrompt })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}, 60_000)
