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

  describe('flush()', () => {
    test('drains a trailing newline-less frame and clears the buffer', () => {
      const decoder = new NdjsonDecoder()

      // No trailing newline: push() yields nothing, the frame stays buffered.
      expect(decoder.push('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}')).toEqual([])

      expect(decoder.flush()).toEqual([
        {
          ok: true,
          value: {
            jsonrpc: '2.0',
            id: '1',
            result: { ok: true },
          },
        },
      ])

      // Buffer is now empty: a second flush() produces no frames.
      expect(decoder.flush()).toEqual([])
    })

    test('returns no frames when the buffer is empty', () => {
      const decoder = new NdjsonDecoder()
      expect(decoder.flush()).toEqual([])
    })

    test('reports a malformed trailing frame instead of throwing', () => {
      const decoder = new NdjsonDecoder()
      expect(decoder.push('{"jsonrpc":"2.0","id":"broken"')).toEqual([])

      const frames = decoder.flush()
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({
        ok: false,
        error: { code: 'INVALID_NDJSON_FRAME' },
      })
    })
  })

  // BUGS.md harness-broker-protocol A1: `NdjsonDecoder.push` constructs a fresh
  // `TextDecoder` per call and decodes without `{ stream: true }`, so a
  // multi-byte UTF-8 codepoint split across two byte chunks is corrupted into
  // U+FFFD replacement characters. This test documents the intended streaming
  // behavior and must be un-skipped once that bug is fixed; left as `.todo` so
  // it does not fail the green suite today.
  test.todo('reassembles a multi-byte UTF-8 char split across two byte chunks (BUGS A1)', () => {
    const decoder = new NdjsonDecoder()

    // "é" (U+00E9) encodes to bytes 0xC3 0xA9; split it across two push() calls.
    const full = Buffer.from('{"jsonrpc":"2.0","id":"é","result":{"ok":true}}\n', 'utf8')
    const splitAt = full.indexOf(0xc3) + 1 // between the two bytes of "é"

    expect(decoder.push(full.subarray(0, splitAt))).toEqual([])
    expect(decoder.push(full.subarray(splitAt))).toEqual([
      {
        ok: true,
        value: {
          jsonrpc: '2.0',
          id: 'é',
          result: { ok: true },
        },
      },
    ])
  })
})
