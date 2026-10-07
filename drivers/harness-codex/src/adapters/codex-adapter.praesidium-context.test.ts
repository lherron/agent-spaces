/**
 * applyPraesidiumContextToCodexHome: the praesidium-context block in codex.home AGENTS.md.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPraesidiumContextToCodexHome } from './codex-adapter.js'

describe('applyPraesidiumContextToCodexHome', () => {
  let workDir: string

  beforeEach(async () => {
    workDir = join(
      tmpdir(),
      `codex-praesidium-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    await mkdir(workDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  test('returns false and writes nothing when both inputs empty', async () => {
    const wrote = await applyPraesidiumContextToCodexHome(workDir, {})
    expect(wrote).toBe(false)
    const exists = await readFile(join(workDir, 'AGENTS.md')).catch(() => null)
    expect(exists).toBeNull()
  })

  test('appends praesidium block to existing AGENTS.md preserving prior content', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), '# Space content\n\nfrom spaces\n')
    const wrote = await applyPraesidiumContextToCodexHome(workDir, {
      systemPrompt: 'I am Cody.',
      reminderContent: 'wrkq has 3 tasks.',
    })
    expect(wrote).toBe(true)
    const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
    expect(out).toContain('# Space content')
    expect(out).toContain('from spaces')
    expect(out).toContain('<!-- BEGIN praesidium-context -->')
    expect(out).toContain('I am Cody.')
    expect(out).toContain('wrkq has 3 tasks.')
    expect(out).toContain('<!-- END praesidium-context -->')
    // Order: system prompt before reminder
    expect(out.indexOf('I am Cody.')).toBeLessThan(out.indexOf('wrkq has 3 tasks.'))
  })

  test('creates AGENTS.md when none exists', async () => {
    const wrote = await applyPraesidiumContextToCodexHome(workDir, { systemPrompt: 'soul only' })
    expect(wrote).toBe(true)
    const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
    expect(out).toContain('soul only')
    expect(out).toContain('<!-- BEGIN praesidium-context -->')
    expect(out).not.toContain('# Space content')
  })

  test('writes only systemPrompt when reminderContent is empty', async () => {
    await applyPraesidiumContextToCodexHome(workDir, { systemPrompt: 'identity here' })
    const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
    const endMarker = '<!-- END praesidium-context -->'
    const block = out.slice(out.indexOf('<!-- BEGIN'), out.indexOf(endMarker) + endMarker.length)
    expect(block).toBe(
      '<!-- BEGIN praesidium-context -->\nidentity here\n<!-- END praesidium-context -->'
    )
  })

  test('writes only reminderContent when systemPrompt is empty', async () => {
    await applyPraesidiumContextToCodexHome(workDir, { reminderContent: 'wrkq state' })
    const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
    const endMarker = '<!-- END praesidium-context -->'
    const block = out.slice(out.indexOf('<!-- BEGIN'), out.indexOf(endMarker) + endMarker.length)
    expect(block).toBe(
      '<!-- BEGIN praesidium-context -->\nwrkq state\n<!-- END praesidium-context -->'
    )
  })

  test('replaces existing praesidium block on repeated calls (no accumulation)', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), '# Space content\n')
    await applyPraesidiumContextToCodexHome(workDir, { systemPrompt: 'first run' })
    await applyPraesidiumContextToCodexHome(workDir, { systemPrompt: 'second run' })
    const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
    expect(out).toContain('# Space content')
    expect(out).toContain('second run')
    expect(out).not.toContain('first run')
    // Exactly one praesidium block
    const beginCount = (out.match(/<!-- BEGIN praesidium-context -->/g) ?? []).length
    const endCount = (out.match(/<!-- END praesidium-context -->/g) ?? []).length
    expect(beginCount).toBe(1)
    expect(endCount).toBe(1)
  })

  test('removes every stale praesidium block before appending fresh content', async () => {
    await writeFile(
      join(workDir, 'AGENTS.md'),
      [
        '# Space content',
        '<!-- BEGIN praesidium-context -->',
        'stale one',
        '<!-- END praesidium-context -->',
        'between',
        '<!-- BEGIN praesidium-context -->',
        'stale two',
        '<!-- END praesidium-context -->',
        '',
      ].join('\n')
    )

    await applyPraesidiumContextToCodexHome(workDir, { systemPrompt: 'fresh' })
    const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')

    expect(out).toContain('# Space content')
    expect(out).toContain('between')
    expect(out).toContain('fresh')
    expect(out).not.toContain('stale one')
    expect(out).not.toContain('stale two')
    expect((out.match(/<!-- BEGIN praesidium-context -->/g) ?? []).length).toBe(1)
    expect((out.match(/<!-- END praesidium-context -->/g) ?? []).length).toBe(1)
  })

  test('cleans stale praesidium block when no fresh content is provided', async () => {
    await writeFile(
      join(workDir, 'AGENTS.md'),
      [
        '# Space content',
        '<!-- BEGIN praesidium-context -->',
        'stale prompt',
        '<!-- END praesidium-context -->',
        '',
      ].join('\n')
    )

    const wrote = await applyPraesidiumContextToCodexHome(workDir, {})
    const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')

    expect(wrote).toBe(true)
    expect(out).toBe('# Space content\n')
  })
})
