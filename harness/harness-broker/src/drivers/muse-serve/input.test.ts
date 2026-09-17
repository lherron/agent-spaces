/**
 * muse-serve input builder tests (T-08589, spike 4).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationInput } from 'spaces-harness-broker-protocol'
import { buildMuseInputParts, buildMuseTurnStartParams, extractMuseText } from './input'

const textInput = (text: string): InvocationInput => ({
  kind: 'user',
  content: [{ type: 'text', text }],
})

describe('buildMuseInputParts', () => {
  test('passes text through and joins for the user message', () => {
    expect(extractMuseText(textInput('hello'))).toBe('hello')
  })

  test('renders file_ref as @path text mentions', async () => {
    const parts = await buildMuseInputParts({
      kind: 'user',
      content: [{ type: 'file_ref', path: 'src/index.ts' }],
    })
    expect(parts).toEqual([{ type: 'text', text: '@src/index.ts' }])
  })

  test('encodes local_image as base64 with media type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'muse-input-'))
    try {
      const path = join(dir, 'shot.png')
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const parts = await buildMuseInputParts({
        kind: 'user',
        content: [{ type: 'local_image', path }],
      })
      expect(parts).toEqual([
        {
          type: 'image',
          base64Data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          mediaType: 'image/png',
        },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects unknown extensions and empty inputs without touching the wire', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'muse-input-'))
    try {
      const path = join(dir, 'blob.xyz')
      await writeFile(path, 'x')
      await expect(
        buildMuseInputParts({ kind: 'user', content: [{ type: 'local_image', path }] })
      ).rejects.toThrow('unknown extension')
      await expect(buildMuseInputParts({ kind: 'user', content: [] })).rejects.toThrow(
        'at least one content part'
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('buildMuseTurnStartParams', () => {
  test('never passes ifBusy; carries reasoning effort when set', async () => {
    const params = await buildMuseTurnStartParams({
      commandId: 'cmd-1',
      sessionId: 'sess-1',
      input: textInput('hi'),
      reasoningEffort: 'high',
    })
    expect(params).toMatchObject({
      commandId: 'cmd-1',
      sessionId: 'sess-1',
      reasoningEffort: 'high',
    })
    expect('ifBusy' in params).toBe(false)
  })
})
