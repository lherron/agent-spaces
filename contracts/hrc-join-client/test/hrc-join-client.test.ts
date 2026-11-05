import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HRC_JOIN_CLIENT_VERSION,
  attachParticipant,
  isAttachConflict,
  isAttachEpochStale,
  isHostBindingConflict,
  isIncarnationBoundElsewhere,
  isRedirect,
  isScopeOccupied,
  joinAsParticipant,
  registerParticipant,
} from 'spaces-hrc-join-client'

function socketPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'hrc-join-')), 'hrc.sock')
}

/** `User-Agent` of every request a stub received (L3 client name, hrc-runtime T-11541). */
const receivedClients: (string | null)[] = []

function stubHrc(handler: (path: string, body: unknown) => { status: number; body: unknown }) {
  const sock = socketPath()
  const server = Bun.serve({
    unix: sock,
    async fetch(request) {
      receivedClients.push(request.headers.get('user-agent'))
      const url = new URL(request.url)
      const body = await request.json().catch(() => undefined)
      const { status, body: response } = handler(url.pathname, body)
      return Response.json(response, { status })
    },
  })
  return { sock, stop: () => server.stop() }
}

const REGISTERED = {
  status: 'registered',
  scopeRef: 'agent:stella:project:demo:task:primary-nova',
  hostSessionId: 'hs_1',
  generation: 1,
  created: true,
  resumed: false,
  observation: { state: 'attachment_pending', detail: 'ok' },
  identity: {
    registrationId: 'reg_1',
    laneRef: 'main',
    runtimeId: 'rt_1',
    attemptId: 'att_1',
    invocationId: 'inv_1',
    attachEpoch: 1,
    requestId: 'req_1',
    operationId: 'op_1',
  },
}

describe('hrc join client', () => {
  test('register maps a registered response with HRC-minted identity', async () => {
    const { sock, stop } = stubHrc(() => ({ status: 200, body: REGISTERED }))
    try {
      const result = await registerParticipant(sock, {
        registrationMode: 'direct',
        requestedSessionRef: 'agent:stella:project:demo:task:primary-nova',
        hostIncarnationId: 'host-incarnation:abc',
        socketPath: '/tmp/broker.sock',
      })
      expect(result.outcome).toBe('registered')
      if (result.outcome !== 'registered') return
      expect(result.identity.registrationId).toBe('reg_1')
      expect(result.identity.attachEpoch).toBe(1)
    } finally {
      stop()
    }
  })

  test('register maps 409 participant_scope_occupied as rejected with helper', async () => {
    const { sock, stop } = stubHrc(() => ({
      status: 409,
      body: { status: 'rejected', reason: 'participant_scope_occupied', detail: 'held' },
    }))
    try {
      const result = await registerParticipant(sock, {
        registrationMode: 'direct',
        requestedSessionRef: 'agent:stella:project:demo:task:primary-nova',
        hostIncarnationId: 'host-incarnation:abc',
      })
      expect(result.outcome).toBe('rejected')
      expect(isScopeOccupied(result)).toBe(true)
      expect(isRedirect(result)).toBe(false)
    } finally {
      stop()
    }
  })

  test('register maps redirect reasons with observed home node', async () => {
    const { sock, stop } = stubHrc(() => ({
      status: 409,
      body: {
        status: 'rejected',
        reason: 'participant_scope_bound_elsewhere',
        detail: 'elsewhere',
        observed: { homeNodeId: 'node-b' },
      },
    }))
    try {
      const result = await registerParticipant(sock, {
        registrationMode: 'direct',
        requestedSessionRef: 'agent:stella:project:demo:task:primary-nova',
        hostIncarnationId: 'host-incarnation:abc',
      })
      expect(isRedirect(result)).toBe(true)
      expect(isHostBindingConflict(result)).toBe(false)
      expect(isIncarnationBoundElsewhere(result)).toBe(false)
    } finally {
      stop()
    }
  })

  test('register maps host_binding_conflict and incarnation_bound_elsewhere', async () => {
    for (const reason of [
      'host_binding_conflict',
      'participant_host_incarnation_bound_elsewhere',
    ]) {
      const { sock, stop } = stubHrc(() => ({
        status: 409,
        body: { status: 'rejected', reason, detail: reason },
      }))
      try {
        const result = await registerParticipant(sock, {
          registrationMode: 'direct',
          requestedSessionRef: 'agent:stella:project:demo:task:primary-nova',
          hostIncarnationId: 'host-incarnation:abc',
        })
        expect(result.outcome).toBe('rejected')
        expect(isHostBindingConflict(result)).toBe(reason === 'host_binding_conflict')
        expect(isIncarnationBoundElsewhere(result)).toBe(
          reason === 'participant_host_incarnation_bound_elsewhere'
        )
      } finally {
        stop()
      }
    }
  })

  test('attach sends only the participant descriptor and maps epoch-stale / conflict refusals', async () => {
    let attachedRequest: unknown
    const attached = stubHrc((_path, body) => {
      attachedRequest = body
      return {
        status: 200,
        body: {
          status: 'attached',
          registrationId: 'reg_1',
          attemptId: 'att_1',
          attachEpoch: 1,
          prepared: true,
          observation: { state: 'attached', detail: 'ok' },
        },
      }
    })
    try {
      const result = await attachParticipant(attached.sock, {
        registrationId: 'reg_1',
        attemptId: 'att_1',
        attachEpoch: 1,
        socketPath: '/tmp/broker.sock',
        descriptor: { kind: 'descriptor' } as never,
      })
      expect(result.outcome).toBe('attached')
      expect(attachedRequest).toMatchObject({
        descriptor: { kind: 'descriptor' },
      })
      expect(attachedRequest).not.toHaveProperty('profile')
    } finally {
      attached.stop()
    }
    const stale = stubHrc(() => ({
      status: 409,
      body: {
        status: 'rejected',
        reason: 'participant_attach_epoch_stale',
        detail: 'stale',
      },
    }))
    try {
      const result = await attachParticipant(stale.sock, {
        registrationId: 'reg_1',
        attemptId: 'att_1',
        attachEpoch: 1,
        descriptor: { kind: 'descriptor' } as never,
      })
      expect(isAttachEpochStale(result)).toBe(true)
      expect(isAttachConflict(result)).toBe(false)
    } finally {
      stale.stop()
    }
    const conflict = stubHrc(() => ({
      status: 409,
      body: { status: 'rejected', reason: 'participant_attach_conflict', detail: 'frozen' },
    }))
    try {
      const result = await attachParticipant(conflict.sock, {
        registrationId: 'reg_1',
        attemptId: 'att_1',
        attachEpoch: 1,
        descriptor: { kind: 'descriptor' } as never,
      })
      expect(isAttachConflict(result)).toBe(true)
    } finally {
      conflict.stop()
    }
  })

  test('join runs register, prepare, attach in order with HRC identity', async () => {
    const seen: string[] = []
    const { sock, stop } = stubHrc((path) => {
      seen.push(path)
      if (path === '/v1/participants/register') return { status: 200, body: REGISTERED }
      return {
        status: 200,
        body: {
          status: 'attached',
          registrationId: 'reg_1',
          attemptId: 'att_1',
          attachEpoch: 1,
          prepared: true,
          observation: { state: 'attached', detail: 'ok' },
        },
      }
    })
    try {
      let preparedWith: unknown
      const result = await joinAsParticipant({
        hrcSocketPath: sock,
        register: {
          registrationMode: 'direct',
          requestedSessionRef: 'agent:stella:project:demo:task:primary-nova',
          hostIncarnationId: 'host-incarnation:abc',
          socketPath: '/tmp/broker.sock',
        },
        prepare: {
          classId: 'codex-desktop',
          participantKey: 'k',
          workspaceCwd: '/tmp',
          preparation: { schema: 'test/1' },
        },
        adapter: {
          adapterId: 'test-adapter/1',
          admit: () => ({ status: 'rejected' as const, reason: 'unused' }),
          prepare: (request) => {
            preparedWith = request
            return { status: 'prepared' as const, descriptor: { kind: 'echo' } as never }
          },
        },
      })
      expect(seen).toEqual(['/v1/participants/register', '/v1/participants/attach'])
      expect(result.outcome).toBe('attached')
      const identity = (preparedWith as { identity: Record<string, string> }).identity
      expect(identity['registrationId']).toBeUndefined()
      expect(identity['runtimeId']).toBe('rt_1')
      expect(identity['invocationId']).toBe('inv_1')
    } finally {
      stop()
    }
  })

  test('join stops at a refused register without preparing', async () => {
    const { sock, stop } = stubHrc(() => ({
      status: 200,
      body: { status: 'pending', reason: 'host_retirement_unproven', detail: 'hold' },
    }))
    try {
      let prepared = false
      const result = await joinAsParticipant({
        hrcSocketPath: sock,
        register: {
          registrationMode: 'direct',
          requestedSessionRef: 'agent:stella:project:demo:task:primary-nova',
          hostIncarnationId: 'host-incarnation:abc',
        },
        prepare: {
          classId: 'codex-desktop',
          participantKey: 'k',
          workspaceCwd: '/tmp',
          preparation: null,
        },
        adapter: {
          adapterId: 'test-adapter/1',
          admit: () => ({ status: 'rejected' as const, reason: 'unused' }),
          prepare: () => {
            prepared = true
            return { status: 'prepared' as const, descriptor: {} as never }
          },
        },
      })
      expect(result.outcome).toBe('register-refused')
      expect(prepared).toBe(false)
    } finally {
      stop()
    }
  })
})

describe('caller attribution (T-11541)', () => {
  test('every join request names itself to HRC request metrics', async () => {
    receivedClients.length = 0
    const hrc = stubHrc(() => ({ status: 200, body: REGISTERED }))
    try {
      const result = await registerParticipant(hrc.sock, {
        registrationMode: 'direct',
        requestedSessionRef: 'agent:stella:project:demo:task:primary-nova',
        hostIncarnationId: 'host-incarnation:abc',
        socketPath: '/tmp/broker.sock',
      })
      expect(result.outcome).toBe('registered')
    } finally {
      hrc.stop()
    }
    expect(receivedClients).toEqual([`hrc-join-client/${HRC_JOIN_CLIENT_VERSION}`])
  })
})

/**
 * service-api rev 4 §3 (T-12500): every join request names its first-party
 * caller in `X-Praesidium-Caller`: an explicit `caller` option, else
 * PRAESIDIUM_CALLER, else ASP_HANDLE, else tty/unknown.
 */
describe('X-Praesidium-Caller', () => {
  const REGISTER = {
    registrationMode: 'direct' as const,
    requestedSessionRef: 'agent:stella:project:demo:task:primary-nova',
    hostIncarnationId: 'host-incarnation:abc',
    socketPath: '/tmp/broker.sock',
  }
  const ATTACHED = {
    status: 'attached',
    registrationId: 'reg_1',
    attemptId: 'att_1',
    attachEpoch: 1,
    prepared: true,
  }

  async function callersFor(
    env: { PRAESIDIUM_CALLER?: string; ASP_HANDLE?: string },
    run: (sock: string) => Promise<unknown>
  ): Promise<(string | null)[]> {
    const seen: (string | null)[] = []
    const sock = socketPath()
    const server = Bun.serve({
      unix: sock,
      fetch(request) {
        seen.push(request.headers.get('x-praesidium-caller'))
        const path = new URL(request.url).pathname
        return Response.json(path.endsWith('/attach') ? ATTACHED : REGISTERED)
      },
    })
    const saved = {
      PRAESIDIUM_CALLER: process.env['PRAESIDIUM_CALLER'],
      ASP_HANDLE: process.env['ASP_HANDLE'],
    }
    for (const key of ['PRAESIDIUM_CALLER', 'ASP_HANDLE'] as const) {
      if (env[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = env[key]
    }
    try {
      await run(sock)
    } finally {
      server.stop(true)
      for (const key of ['PRAESIDIUM_CALLER', 'ASP_HANDLE'] as const) {
        if (saved[key] === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = saved[key]
      }
    }
    return seen
  }

  test('an explicit caller option wins over the environment', async () => {
    const seen = await callersFor(
      { PRAESIDIUM_CALLER: 'from-env', ASP_HANDLE: 'mable@x:primary' },
      (sock) => registerParticipant(sock, REGISTER, { caller: 'foundry-host:wrkq' })
    )
    expect(seen).toEqual(['foundry-host:wrkq'])
  })

  test('PRAESIDIUM_CALLER is used when no caller option is given', async () => {
    const seen = await callersFor(
      { PRAESIDIUM_CALLER: 'foundry-kernel:wrkq', ASP_HANDLE: 'mable@x:primary' },
      (sock) => registerParticipant(sock, REGISTER)
    )
    expect(seen).toEqual(['foundry-kernel:wrkq'])
  })

  test('ASP_HANDLE names the seat when nothing else does', async () => {
    const seen = await callersFor({ ASP_HANDLE: 'cody@foundry:T-12509' }, (sock) =>
      registerParticipant(sock, REGISTER)
    )
    expect(seen).toEqual(['cody@foundry:T-12509'])
  })

  test('falls back to tty or unknown', async () => {
    const seen = await callersFor({}, (sock) => registerParticipant(sock, REGISTER))
    expect(seen).toEqual([process.stdin.isTTY ? 'tty' : 'unknown'])
  })

  test('joinAsParticipant sends its caller on both register and attach', async () => {
    const seen = await callersFor({ PRAESIDIUM_CALLER: 'from-env' }, (sock) =>
      joinAsParticipant({
        hrcSocketPath: sock,
        caller: 'foundry-host:wrkq',
        register: REGISTER,
        prepare: {
          classId: 'codex-desktop',
          participantKey: 'k',
          workspaceCwd: '/tmp',
          preparation: null,
        },
        adapter: {
          adapterId: 'test-adapter/1',
          admit: () => ({ status: 'rejected' as const, reason: 'unused' }),
          prepare: () => ({ status: 'prepared' as const, descriptor: { kind: 'echo' } as never }),
        },
      })
    )
    expect(seen).toEqual(['foundry-host:wrkq', 'foundry-host:wrkq'])
  })
})
