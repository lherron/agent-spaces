/**
 * service-api rev 4 §3 (R-00605): the broker's mail stop/hint queries name the
 * seat they serve in `X-Praesidium-Caller`, so HRC stops logging them as
 * caller=unknown. PRAESIDIUM_CALLER wins, else ASP_HANDLE (agent@project:lane).
 * The request is hand-written HTTP, so a value outside the §3 grammar is never
 * written into it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HRC_MAIL_STOP_SOCKET_ENV,
  queryMailHintDecision,
  queryMailStopDecision,
} from '../../src/drivers/mail-stop-gate'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function hrcStub(): Promise<{
  socketPath: string
  seen: { url?: string; caller?: string | string[]; headers: string[] }[]
  close: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'mail-gate-caller-'))
  roots.push(root)
  const socketPath = join(root, 'hrc.sock')
  const seen: { url?: string; caller?: string | string[]; headers: string[] }[] = []
  const server = createServer((request, reply) => {
    request.resume()
    request.on('end', () => {
      seen.push({
        ...(request.url !== undefined ? { url: request.url } : {}),
        ...(request.headers['x-praesidium-caller'] !== undefined
          ? { caller: request.headers['x-praesidium-caller'] }
          : {}),
        headers: Object.keys(request.headers).sort(),
      })
      reply.writeHead(200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify({ decision: 'block', reason: 'held', hint: 'h' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const env = (socketPath: string, extra: Record<string, string>) => ({
  [HRC_MAIL_STOP_SOCKET_ENV]: socketPath,
  HARNESS_BROKER_RUNTIME_ID: 'rt-caller',
  ...extra,
})

describe('mail gate X-Praesidium-Caller', () => {
  test('stop and hint queries name the seat from ASP_HANDLE', async () => {
    const hrc = await hrcStub()
    try {
      const seat = env(hrc.socketPath, { ASP_HANDLE: 'mable@agent-spaces:primary' })
      expect(await queryMailStopDecision({ hook_event_name: 'Stop' }, seat)).toEqual({
        decision: 'block',
        reason: 'held',
      })
      expect(await queryMailHintDecision({ hook_event_name: 'PostToolUse' }, seat)).toEqual({
        hint: 'h',
      })
    } finally {
      await hrc.close()
    }
    expect(hrc.seen.map((r) => [r.url, r.caller])).toEqual([
      ['/v1/internal/mail/stop-decision', 'mable@agent-spaces:primary'],
      ['/v1/internal/mail/hint-decision', 'mable@agent-spaces:primary'],
    ])
  })

  test('PRAESIDIUM_CALLER wins over ASP_HANDLE', async () => {
    const hrc = await hrcStub()
    try {
      await queryMailStopDecision(
        { hook_event_name: 'Stop' },
        env(hrc.socketPath, { PRAESIDIUM_CALLER: 'foundry-host:wrkq', ASP_HANDLE: 'x@y:z' })
      )
    } finally {
      await hrc.close()
    }
    expect(hrc.seen.map((r) => r.caller)).toEqual(['foundry-host:wrkq'])
  })

  test('a value outside the caller grammar is not written into the request', async () => {
    const hrc = await hrcStub()
    try {
      const result = await queryMailStopDecision(
        { hook_event_name: 'Stop' },
        env(hrc.socketPath, { ASP_HANDLE: 'mable@x:primary\r\nX-Injected: 1' })
      )
      expect(result).toEqual({ decision: 'block', reason: 'held' })
    } finally {
      await hrc.close()
    }
    expect(hrc.seen).toHaveLength(1)
    expect(hrc.seen[0]?.caller).toBeUndefined()
    expect(hrc.seen[0]?.headers).not.toContain('x-injected')
  })

  test('no seat identity sends no caller header', async () => {
    const hrc = await hrcStub()
    try {
      await queryMailStopDecision({ hook_event_name: 'Stop' }, env(hrc.socketPath, {}))
    } finally {
      await hrc.close()
    }
    expect(hrc.seen.map((r) => r.caller)).toEqual([undefined])
  })
})
