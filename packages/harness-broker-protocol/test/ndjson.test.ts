import { describe, expect, test } from 'bun:test'
import { NdjsonDecoder, encodeNdjsonFrame } from '../src/ndjson'

describe('NDJSON JSON-RPC framing', () => {
  test('reassembles frames split across chunks', () => {
    const decoder = new NdjsonDecoder()

    expect(decoder.push('{"jsonrpc":"2.0","id"')).toEqual([])
    expect(decoder.push(':"1","result":{"ok":true}}\n')).toEqual([
      {
        ok: true,
        value: {
          jsonrpc: '2.0',
          id: '1',
          result: { ok: true },
        },
      },
    ])
  })

  test('decodes multiple frames from a single chunk', () => {
    const decoder = new NdjsonDecoder()

    expect(
      decoder.push(
        '{"jsonrpc":"2.0","id":"1","result":{"ok":true}}\n{"jsonrpc":"2.0","method":"invocation.event","params":{"invocationId":"inv_1","seq":1,"time":"2026-05-20T18:00:00.000Z","type":"invocation.ready","payload":{}}}\n'
      )
    ).toEqual([
      {
        ok: true,
        value: {
          jsonrpc: '2.0',
          id: '1',
          result: { ok: true },
        },
      },
      {
        ok: true,
        value: {
          jsonrpc: '2.0',
          method: 'invocation.event',
          params: {
            invocationId: 'inv_1',
            seq: 1,
            time: '2026-05-20T18:00:00.000Z',
            type: 'invocation.ready',
            payload: {},
          },
        },
      },
    ])
  })

  test('reports malformed JSON lines and recovers for subsequent frames', () => {
    const decoder = new NdjsonDecoder()

    const frames = decoder.push(
      '{"jsonrpc":"2.0","id":"broken"\n{"jsonrpc":"2.0","id":"2","result":{"ok":true}}\n'
    )

    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_NDJSON_FRAME',
      },
    })
    expect(frames[1]).toEqual({
      ok: true,
      value: {
        jsonrpc: '2.0',
        id: '2',
        result: { ok: true },
      },
    })
  })

  test('encodes exactly one newline-terminated JSON object per frame', () => {
    expect(encodeNdjsonFrame({ jsonrpc: '2.0', id: '1', result: true })).toBe(
      '{"jsonrpc":"2.0","id":"1","result":true}\n'
    )
  })
})
