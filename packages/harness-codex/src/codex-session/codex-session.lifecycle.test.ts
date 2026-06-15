import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import { CodexSession } from './codex-session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `codex-session-lifecycle-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function codexLifecycleShimScript(mode: 'complete' | 'error-then-complete'): string {
  return `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const threadId = 'thread-lifecycle';
const turnId = 'turn-lifecycle';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function thread() {
  return {
    id: threadId,
    preview: '',
    modelProvider: 'openai',
    createdAt: 0,
    path: process.cwd(),
    cwd: process.cwd(),
    cliVersion: '0.0.0',
    source: 'appServer',
    gitInfo: null,
    turns: [],
  };
}

function turn(status) {
  return { id: turnId, items: [], status, error: null };
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex-lifecycle-shim' } });
    return;
  }
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: thread() } });
    return;
  }
  if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: turn('inProgress') } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: turn('inProgress') } });
    ${
      mode === 'error-then-complete'
        ? `send({
      jsonrpc: '2.0',
      method: 'error',
      params: {
        threadId,
        turnId,
        willRetry: false,
        error: { message: 'first failure', codexErrorInfo: null, additionalDetails: 'details' },
      },
    });
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: turn('completed') } });
    }, 5);`
        : `setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: turn('completed') } });
    }, 5);`
    }
  }
});
`
}

async function makeStartedSession(mode: 'complete' | 'error-then-complete') {
  const shimPath = join(tmpDir, `codex-${mode}.js`)
  const codexHome = join(tmpDir, 'codex-home')
  await writeFile(shimPath, codexLifecycleShimScript(mode), 'utf-8')
  await chmod(shimPath, 0o755)
  await mkdir(codexHome, { recursive: true })

  const session = new CodexSession({
    ownerId: 'owner-lifecycle',
    cwd: tmpDir,
    sessionId: 'codex-session-lifecycle',
    homeDir: codexHome,
    appServerCommand: shimPath,
    model: 'gpt-5.3-codex',
  })
  const events: UnifiedSessionEvent[] = []
  session.onEvent((event) => events.push(event))
  await session.start()
  return { session, events }
}

describe('CodexSession state transition characterization (T-04638)', () => {
  test('illegal transition errors keep exact message strings', async () => {
    const idleSession = new CodexSession({
      ownerId: 'owner-idle',
      cwd: tmpDir,
      sessionId: 'codex-idle',
      homeDir: tmpDir,
    })

    await expect(idleSession.sendPrompt('too soon')).rejects.toThrow(
      'Cannot send prompt in state: idle'
    )

    const { session } = await makeStartedSession('complete')
    await expect(session.start()).rejects.toThrow('Cannot start session in state: running')
    await session.stop('done')
    await expect(session.sendPrompt('after stop')).rejects.toThrow(
      'Cannot send prompt in state: stopped'
    )
  })

  test('successful turn rolls streaming back to running and preserves metadata outputs', async () => {
    const { session, events } = await makeStartedSession('complete')

    await session.sendPrompt('complete normally')

    expect(session.getState()).toBe('running')
    expect(session.isHealthy()).toBe(true)
    expect(session.getMetadata()).toMatchObject({
      sessionId: 'codex-session-lifecycle',
      kind: 'codex',
      state: 'running',
      nativeIdentity: 'thread-lifecycle',
      continuationKey: 'thread-lifecycle',
      capabilities: {
        supportsInterrupt: false,
        supportsInFlightInput: false,
        supportsNativeResume: true,
        supportsAttach: false,
      },
    })
    expect(events.map((event) => event.type)).toEqual(['agent_start', 'turn_start', 'turn_end'])

    await session.stop('done')
  })

  test('error notification wins over later completion and sendPrompt preserves that error text', async () => {
    const { session, events } = await makeStartedSession('error-then-complete')

    await expect(session.sendPrompt('fail then complete')).rejects.toThrow(
      'Codex error - turn turn-lifecycle - thread thread-lifecycle: first failure (details)'
    )
    await Bun.sleep(25)

    expect(session.getState()).toBe('error')
    expect(session.isHealthy()).toBe(false)
    expect(session.getMetadata().state).toBe('error')
    expect(events.map((event) => event.type)).toEqual(['agent_start', 'turn_start'])

    await session.stop('cleanup')
  })
})
