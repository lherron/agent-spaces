import { describe, expect, it } from 'bun:test'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import { runCodexAppServerOneShot } from './run-one-shot'

function spawnAppServer(script: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
}

function fallbackAppServerScript(resumeErrorMessage: string): string {
  return [
    "const readline = require('node:readline')",
    'const rl = readline.createInterface({ input: process.stdin })',
    'function send(value) { process.stdout.write(JSON.stringify(value) + "\\n") }',
    "rl.on('line', (line) => {",
    '  const msg = JSON.parse(line)',
    "  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} })",
    "  if (msg.method === 'thread/resume') {",
    `    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: ${JSON.stringify(
      resumeErrorMessage
    )} } })`,
    '  }',
    "  if (msg.method === 'thread/start') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-new' } } })",
    '  }',
    "  if (msg.method === 'turn/start') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-new' } } })",
    "    send({ jsonrpc: '2.0', method: 'item/completed', params: { turnId: 'turn-new', item: { type: 'agentMessage', id: 'msg-new', text: 'fresh thread reply' } } })",
    "    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-new', turn: { id: 'turn-new', status: 'completed', items: [] } } })",
    '    setTimeout(() => process.exit(0), 10)',
    '  }',
    '})',
  ].join('\n')
}

describe('runCodexAppServerOneShot resume fallback', () => {
  it('falls back to thread/start when resume reports no rollout found', async () => {
    const proc = spawnAppServer(fallbackAppServerScript('No rollout found for thread thread-old'))
    const events: Array<Record<string, unknown>> = []
    const continuations: string[] = []

    const result = await runCodexAppServerOneShot({
      proc,
      cwd: process.cwd(),
      prompt: 'continue',
      resumeThreadId: 'thread-old',
      onContinuation: (threadId) => {
        continuations.push(threadId)
      },
      onEvent: (event) => {
        events.push(event as Record<string, unknown>)
      },
    })

    expect(result.threadId).toBe('thread-new')
    expect(result.finalOutput).toBe('fresh thread reply')
    expect(continuations).toEqual(['thread-new'])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        level: 'warn',
        message: expect.stringMatching(/prior codex thread.*lost/i),
      })
    )
  })

  it('does not fall back for non-matching resume errors', async () => {
    const proc = spawnAppServer(fallbackAppServerScript('invalid resume request'))

    await expect(
      runCodexAppServerOneShot({
        proc,
        cwd: process.cwd(),
        prompt: 'continue',
        resumeThreadId: 'thread-old',
      })
    ).rejects.toThrow(/invalid resume request/i)
  })
})
