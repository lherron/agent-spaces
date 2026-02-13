import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import { CodexSession } from './codex-session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `codex-session-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function codexShimScript(): string {
  return `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');

const approvalLog = process.env.CODEX_APPROVAL_LOG;
const rl = readline.createInterface({ input: process.stdin });

const threadId = 'thread-test';
const turnId = 'turn-1';
let approvalPendingId = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function thread() {
  return {
    id: threadId,
    preview: '',
    modelProvider: 'openai',
    createdAt: Math.floor(Date.now() / 1000),
    path: '/tmp',
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

function logApproval(result) {
  if (!approvalLog) return;
  fs.appendFileSync(approvalLog, JSON.stringify(result) + '\\n');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex-shim' } });
    return;
  }
  if (msg.method === 'initialized') {
    return;
  }
  if (msg.method === 'thread/start') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        thread: thread(),
        model: 'gpt-5.3-codex',
        modelProvider: 'openai',
        cwd: process.cwd(),
        approvalPolicy: 'on-request',
        sandbox: { type: 'readOnly' },
        reasoningEffort: null,
      },
    });
    return;
  }
  if (msg.method === 'thread/resume') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        thread: thread(),
        model: 'gpt-5.3-codex',
        modelProvider: 'openai',
        cwd: process.cwd(),
        approvalPolicy: 'on-request',
        sandbox: { type: 'readOnly' },
        reasoningEffort: null,
      },
    });
    return;
  }
  if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: turn('inProgress') } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: turn('inProgress') } });
    send({
      jsonrpc: '2.0',
      method: 'item/started',
      params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg-1', text: '' } },
    });
    send({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { threadId, turnId, itemId: 'msg-1', delta: 'Hello' },
    });
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg-1', text: 'Hello' } },
    });

    const commandItem = {
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'ls',
      cwd: process.cwd(),
      processId: null,
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    send({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, item: commandItem } });

    approvalPendingId = 42;
    send({
      jsonrpc: '2.0',
      id: approvalPendingId,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: 'cmd-1',
        reason: 'test approval',
        proposedExecpolicyAmendment: null,
      },
    });
    return;
  }

  if (msg.id && msg.result && approvalPendingId && msg.id === approvalPendingId) {
    logApproval(msg.result);
    approvalPendingId = null;
    send({
      jsonrpc: '2.0',
      method: 'item/commandExecution/outputDelta',
      params: { threadId, turnId, itemId: 'cmd-1', delta: 'ok' },
    });
    const commandCompleted = {
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'ls',
      cwd: process.cwd(),
      processId: null,
      status: 'completed',
      commandActions: [],
      aggregatedOutput: 'ok',
      exitCode: 0,
      durationMs: 5,
    };
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { threadId, turnId, item: commandCompleted },
    });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: turn('completed') } });
  }
});
`
}

function codexErrorShimScript(): string {
  return `#!/usr/bin/env node
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });
const threadId = 'thread-error';
const turnId = 'turn-error';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function thread() {
  return {
    id: threadId,
    preview: '',
    modelProvider: 'openai',
    createdAt: Math.floor(Date.now() / 1000),
    path: '/tmp',
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
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex-shim' } });
    return;
  }
  if (msg.method === 'initialized') {
    return;
  }
  if (msg.method === 'thread/start') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        thread: thread(),
        model: 'gpt-5.3-codex',
        modelProvider: 'openai',
        cwd: process.cwd(),
        approvalPolicy: 'on-request',
        sandbox: { type: 'readOnly' },
        reasoningEffort: null,
      },
    });
    return;
  }
  if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: turn('inProgress') } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: turn('inProgress') } });
    send({
      jsonrpc: '2.0',
      method: 'error',
      params: {
        threadId,
        turnId,
        willRetry: false,
        error: {
          message: 'turn failed',
          codexErrorInfo: null,
          additionalDetails: 'shim failure',
        },
      },
    });
  }
});
`
}

describe('CodexSession', () => {
  test('streams events and responds to approvals', async () => {
    const shimPath = join(tmpDir, 'codex-shim.js')
    const approvalLog = join(tmpDir, 'approvals.jsonl')
    const codexHome = join(tmpDir, 'codex-home')

    await writeFile(shimPath, codexShimScript(), 'utf-8')
    await chmod(shimPath, 0o755)
    await mkdir(codexHome, { recursive: true })

    const priorApprovalLog = process.env['CODEX_APPROVAL_LOG']
    process.env['CODEX_APPROVAL_LOG'] = approvalLog

    const session = new CodexSession({
      ownerId: 'owner',
      cwd: '/tmp',
      sessionId: 'session-test',
      homeDir: codexHome,
      appServerCommand: shimPath,
      model: 'gpt-5.3-codex',
      approvalPolicy: 'on-request',
    })

    let requested = false
    session.setPermissionHandler({
      isAutoAllowed: () => false,
      requestPermission: async () => {
        requested = true
        return { allowed: true }
      },
    })

    const events: UnifiedSessionEvent[] = []
    session.onEvent((event) => events.push(event))

    try {
      await session.start()
      await session.sendPrompt('Hello')
      await session.stop('complete')
    } finally {
      if (priorApprovalLog === undefined) {
        process.env['CODEX_APPROVAL_LOG'] = undefined
      } else {
        process.env['CODEX_APPROVAL_LOG'] = priorApprovalLog
      }
    }

    const eventTypes = events.map((event) => event.type)
    expect(eventTypes).toContain('turn_start')
    expect(eventTypes).toContain('message_start')
    expect(eventTypes).toContain('message_update')
    expect(eventTypes).toContain('message_end')
    expect(eventTypes).toContain('tool_execution_start')
    expect(eventTypes).toContain('tool_execution_update')
    expect(eventTypes).toContain('tool_execution_end')
    expect(eventTypes).toContain('turn_end')

    expect(requested).toBe(true)

    const approvalRaw = await readFile(approvalLog, 'utf-8')
    const approvalLine = approvalRaw.trim().split('\n')[0]
    const approval = JSON.parse(approvalLine) as { decision?: string }
    expect(approval.decision).toBe('acceptForSession')
  })

  test('surfaces error notifications', async () => {
    const shimPath = join(tmpDir, 'codex-error-shim.js')
    const codexHome = join(tmpDir, 'codex-home-error')

    await writeFile(shimPath, codexErrorShimScript(), 'utf-8')
    await chmod(shimPath, 0o755)
    await mkdir(codexHome, { recursive: true })

    const session = new CodexSession({
      ownerId: 'owner',
      cwd: '/tmp',
      sessionId: 'session-error',
      homeDir: codexHome,
      appServerCommand: shimPath,
      model: 'gpt-5.3-codex',
      approvalPolicy: 'on-request',
    })

    await session.start()
    try {
      await expect(session.sendPrompt('Hello')).rejects.toThrow('Codex error')
    } finally {
      await session.stop('complete')
    }
  })
})
