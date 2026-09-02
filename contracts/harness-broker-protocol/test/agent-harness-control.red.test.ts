import { describe, expect, test } from 'bun:test'
import * as protocol from '../src/index.js'

// T-07565 red acceptance context: D2 makes this neutral protocol package the
// shared seam between agent-harness and the broker driver. Keep these tests on
// the public package entrypoint so neither consumer becomes the other's owner.

type TestControlFrame = {
  verb: string
  requestId?: string
  payload: unknown
}

type TestSessionConfig = {
  permissionPolicy: { mode: 'deny' | 'allow' | 'ask-client' }
  auth: {
    authMode: 'api-key' | 'oauth'
    authPath: string
    providerId: string
    credentialType: 'api-key' | 'oauth'
    storeBound: boolean
  }
  sdk: {
    modelId: string
    thinkingLevel?: string
  }
  agent: {
    agentId: string
    projectId?: string
    scopeRef?: string
  }
  continuation?: { key: string } | undefined
}

type TestFrameResult = { ok: true; value: TestControlFrame } | { ok: false; error: unknown }

type ExpectedControlApi = {
  validateAgentHarnessControlFrame(value: unknown): TestControlFrame
  validateAgentHarnessSessionConfig(value: unknown): TestSessionConfig
  encodeAgentHarnessControlFrame(frame: TestControlFrame): string
  AgentHarnessControlDecoder: new () => {
    push(chunk: string | Uint8Array): TestFrameResult[]
    flush(): TestFrameResult[]
  }
}

const controlApi = protocol as unknown as Partial<ExpectedControlApi>

const sessionConfig = {
  permissionPolicy: { mode: 'deny' },
  auth: {
    authMode: 'oauth',
    authPath: '/var/run/agent-harness/auth.json',
    providerId: 'anthropic',
    credentialType: 'oauth',
    storeBound: true,
  },
  sdk: {
    modelId: 'claude-sonnet-4-5',
    thinkingLevel: 'high',
  },
  agent: {
    agentId: 'cody',
    projectId: 'agent-spaces',
    scopeRef: 'agent:cody:project:agent-spaces:task:T-07565',
  },
  continuation: { key: 'session_01' },
} as const satisfies TestSessionConfig

const eventPayload = {
  invocationId: 'inv_01',
  seq: 1,
  time: '2026-08-25T20:00:00.000Z',
  turnId: 'turn_01',
  inputId: 'input_01',
  type: 'assistant.message.delta',
  payload: {
    messageId: 'message_01',
    text: 'hello',
  },
}

const frames = [
  {
    verb: 'hello',
    payload: { protocolVersion: 'agent-harness-control/v1' },
  },
  {
    verb: 'session.config',
    requestId: 'request_config_01',
    payload: sessionConfig,
  },
  {
    verb: 'ready',
    payload: { sessionFile: '/workspace/.asp/sessions/session_01.jsonl' },
  },
  {
    verb: 'turn.begin',
    requestId: 'request_turn_01',
    payload: {
      turnId: 'turn_01',
      inputId: 'input_01',
      structured: false,
    },
  },
  {
    verb: 'turn.interrupt',
    requestId: 'request_interrupt_01',
    payload: { reason: 'submission.preempt:submission_01' },
  },
  {
    verb: 'event',
    payload: eventPayload,
  },
] as const satisfies readonly TestControlFrame[]

function requireValidator(): ExpectedControlApi['validateAgentHarnessControlFrame'] {
  expect(typeof controlApi.validateAgentHarnessControlFrame).toBe('function')
  if (typeof controlApi.validateAgentHarnessControlFrame !== 'function') {
    throw new Error('validateAgentHarnessControlFrame must be exported')
  }
  return controlApi.validateAgentHarnessControlFrame
}

function requireConfigValidator(): ExpectedControlApi['validateAgentHarnessSessionConfig'] {
  expect(typeof controlApi.validateAgentHarnessSessionConfig).toBe('function')
  if (typeof controlApi.validateAgentHarnessSessionConfig !== 'function') {
    throw new Error('validateAgentHarnessSessionConfig must be exported')
  }
  return controlApi.validateAgentHarnessSessionConfig
}

function requireEncoder(): ExpectedControlApi['encodeAgentHarnessControlFrame'] {
  expect(typeof controlApi.encodeAgentHarnessControlFrame).toBe('function')
  if (typeof controlApi.encodeAgentHarnessControlFrame !== 'function') {
    throw new Error('encodeAgentHarnessControlFrame must be exported')
  }
  return controlApi.encodeAgentHarnessControlFrame
}

function requireDecoder(): ExpectedControlApi['AgentHarnessControlDecoder'] {
  expect(typeof controlApi.AgentHarnessControlDecoder).toBe('function')
  if (typeof controlApi.AgentHarnessControlDecoder !== 'function') {
    throw new Error('AgentHarnessControlDecoder must be exported')
  }
  return controlApi.AgentHarnessControlDecoder
}

describe('agent-harness-control/v1 framing', () => {
  for (const frame of frames) {
    test(`round-trips the closed ${frame.verb} verb through NDJSON`, () => {
      const encode = requireEncoder()
      const Decoder = requireDecoder()
      const decoder = new Decoder()
      const encoded = encode(frame)

      expect(encoded.endsWith('\n')).toBe(true)
      expect(encoded.slice(0, -1)).not.toContain('\n')
      expect(decoder.push(encoded)).toEqual([{ ok: true, value: frame }])
      expect(decoder.flush()).toEqual([])
    })
  }

  test('reassembles a split frame and decodes multiple frames from one chunk', () => {
    const encode = requireEncoder()
    const Decoder = requireDecoder()
    const decoder = new Decoder()
    const firstFrame = encode(frames[0])
    const splitAt = Math.floor(firstFrame.length / 2)
    const remainingFrames = frames
      .slice(1)
      .map((frame) => encode(frame))
      .join('')

    expect(decoder.push(firstFrame.slice(0, splitAt))).toEqual([])
    expect(decoder.push(firstFrame.slice(splitAt) + remainingFrames)).toEqual(
      frames.map((frame) => ({ ok: true, value: frame }))
    )
  })
})

describe('agent-harness-session-config/v1 validation', () => {
  // `continuation` is deliberately NOT in this list. It is the resume selector,
  // and requiring it made a fresh first launch unrepresentable (T-07585); the
  // two tests below pin absence-is-legal and present-but-malformed-is-not.
  for (const field of ['permissionPolicy', 'auth', 'sdk', 'agent'] as const) {
    test(`refuses a session.config missing required ${field}`, () => {
      const validateConfig = requireConfigValidator()
      const validateFrame = requireValidator()
      const invalid = structuredClone(sessionConfig) as Record<string, unknown>
      Reflect.deleteProperty(invalid, field)

      expect(() => validateConfig(invalid)).toThrow()
      expect(() =>
        validateFrame({
          verb: 'session.config',
          requestId: 'request_config_missing_field',
          payload: invalid,
        })
      ).toThrow()
    })
  }

  test('accepts a session.config with NO continuation — the fresh-launch case', () => {
    const validateConfig = requireConfigValidator()
    const validateFrame = requireValidator()
    const fresh = structuredClone(sessionConfig) as Record<string, unknown>
    Reflect.deleteProperty(fresh, 'continuation')

    expect(() => validateConfig(fresh)).not.toThrow()
    expect(() =>
      validateFrame({
        verb: 'session.config',
        requestId: 'request_config_fresh',
        payload: fresh,
      })
    ).not.toThrow()
  })

  test('still refuses a continuation that is present but malformed', () => {
    const validateConfig = requireConfigValidator()
    for (const continuation of [{}, { key: '' }, { key: 7 }, { key: 'k', extra: 1 }, 'nope']) {
      const invalid = structuredClone(sessionConfig) as Record<string, unknown>
      invalid['continuation'] = continuation
      expect(() => validateConfig(invalid)).toThrow()
    }
  })

  for (const credentialMaterial of [
    { apiKey: 'sk-secret' },
    { accessToken: 'oauth-secret' },
    { credentials: { token: 'nested-secret' } },
  ]) {
    test(`refuses credential material field ${Object.keys(credentialMaterial)[0]} in auth`, () => {
      const validateConfig = requireConfigValidator()
      const validateFrame = requireValidator()
      const invalid = structuredClone(sessionConfig) as TestSessionConfig
      Object.assign(invalid.auth, credentialMaterial)

      expect(() => validateConfig(invalid)).toThrow()
      expect(() =>
        validateFrame({
          verb: 'session.config',
          requestId: 'request_config_with_credential',
          payload: invalid,
        })
      ).toThrow()
    })
  }

  test('accepts only the scalar-and-path auth projection', () => {
    const validate = requireConfigValidator()
    expect(validate(sessionConfig)).toEqual(sessionConfig)
  })
})

describe('closed verb and request validation', () => {
  test('refuses a verb outside the six-member protocol', () => {
    const validate = requireValidator()

    expect(() =>
      validate({
        verb: 'session.reset',
        payload: {},
      })
    ).toThrow()
  })

  for (const requestFrame of frames.filter(
    (frame) =>
      frame.verb === 'session.config' ||
      frame.verb === 'turn.begin' ||
      frame.verb === 'turn.interrupt'
  )) {
    test(`refuses ${requestFrame.verb} without request correlation for its required ack`, () => {
      const validate = requireValidator()
      const invalid = structuredClone(requestFrame) as Record<string, unknown>
      Reflect.deleteProperty(invalid, 'requestId')

      expect(() => validate(invalid)).toThrow()
    })
  }
})

// T-07584: the acknowledgement widened to a result discriminated on `ack`.
// Acks are NOT control frames — the verb set is closed to the six wire verbs —
// so they are recognized and validated on their own path, ahead of the decoder.
describe('agent-harness-control/v1 acknowledgement validation', () => {
  const isAckLine = () => protocol.isAgentHarnessControlAckLine
  const validateAck = () => protocol.validateAgentHarnessControlAck

  test('pins the closed refusal code set', () => {
    expect([...protocol.AGENT_HARNESS_CONTROL_NACK_CODES]).toEqual([
      'turn_already_active',
      'turn_begin_failed',
      'no_active_turn',
    ])
  })

  test('recognizes both polarities as ack lines and control frames as not', () => {
    expect(isAckLine()({ ack: true, requestId: 'r1' })).toBe(true)
    expect(isAckLine()({ ack: false, code: 'turn_begin_failed', message: 'no' })).toBe(true)
    expect(isAckLine()({ verb: 'hello', payload: {} })).toBe(false)
    expect(isAckLine()('not an object')).toBe(false)
    expect(isAckLine()(undefined)).toBe(false)
  })

  test('accepts a positive ack with or without the echoed requestId', () => {
    expect(validateAck()({ ack: true })).toEqual({ ack: true })
    expect(validateAck()({ ack: true, requestId: 'r1' })).toEqual({ ack: true })
  })

  test('accepts a negative ack for every closed code', () => {
    for (const code of protocol.AGENT_HARNESS_CONTROL_NACK_CODES) {
      expect(validateAck()({ ack: false, requestId: 'r1', code, message: 'refused' })).toEqual({
        ack: false,
        code,
        message: 'refused',
      })
    }
  })

  test('refuses a refusal code outside the closed set', () => {
    expect(() =>
      validateAck()({ ack: false, code: 'session_config_failed', message: 'refused' })
    ).toThrow()
  })

  test('refuses a negative ack with no code or no message', () => {
    expect(() => validateAck()({ ack: false, message: 'refused' })).toThrow()
    expect(() => validateAck()({ ack: false, code: 'turn_begin_failed' })).toThrow()
    expect(() => validateAck()({ ack: false, code: 'turn_begin_failed', message: '' })).toThrow()
  })

  test('refuses a positive ack that smuggles a refusal payload', () => {
    expect(() =>
      validateAck()({ ack: true, code: 'turn_already_active', message: 'refused' })
    ).toThrow()
  })

  test('refuses a non-boolean ack, an unknown field, and a non-object', () => {
    expect(() => validateAck()({ ack: 'true' })).toThrow()
    expect(() => validateAck()({ ack: true, retryable: true })).toThrow()
    expect(() => validateAck()('ack')).toThrow()
  })
})
