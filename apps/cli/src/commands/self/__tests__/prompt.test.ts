import { afterEach, describe, expect, test } from 'bun:test'

import { cleanupTempDirs, runAsp, setupSelfFixture } from './test-helpers.js'

afterEach(async () => {
  await cleanupTempDirs()
})

describe('asp self prompt', () => {
  test('shows launched system prompt content and append-mode metadata', async () => {
    const fixture = await setupSelfFixture()
    const result = runAsp(['self', 'prompt', 'system'], fixture.env)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('asp self prompt — system')
    expect(result.stdout).toContain('source: launch argv (--append-system-prompt)')
    expect(result.stdout).toContain('mode:   append')
    expect(result.stdout).toContain('test-sys-prompt')
  })

  test('emits section diagnostics for system prompt from the current template', async () => {
    const fixture = await setupSelfFixture({
      template: `
schema_version = 2
mode = "append"

[[prompt]]
name = "alpha"
type = "inline"
content = "alpha body"

[[prompt]]
name = "heartbeat"
type = "inline"
content = "heartbeat body"
when = { runMode = "heartbeat" }
`.trimStart(),
    })

    const result = runAsp(['self', 'prompt', 'system', '--sections', '--json'], fixture.env)

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      which: string
      sectionRunMode: string
      sectionReports: Array<{ name: string; included: boolean; when?: string }>
    }
    expect(parsed.which).toBe('system')
    expect(parsed.sectionRunMode).toBe('query')
    expect(parsed.sectionReports.find((report) => report.name === 'alpha')?.included).toBe(true)
    const heartbeat = parsed.sectionReports.find((report) => report.name === 'heartbeat')
    expect(heartbeat?.included).toBe(false)
    expect(heartbeat?.when).toContain('runMode=heartbeat')
  })

  test('reads bundle reminder by default and recomputes with --recompute', async () => {
    const fixture = await setupSelfFixture({
      reminderContent: 'materialized reminder',
      template: `
schema_version = 2
mode = "append"

[[reminder]]
name = "rem-alpha"
type = "inline"
content = "recomputed reminder"
`.trimStart(),
    })

    const materialized = runAsp(['self', 'prompt', 'reminder', '--raw'], fixture.env)
    expect(materialized.exitCode).toBe(0)
    expect(materialized.stdout.trim()).toBe('materialized reminder')

    const recomputed = runAsp(['self', 'prompt', 'reminder', '--recompute', '--raw'], fixture.env)
    expect(recomputed.exitCode).toBe(0)
    expect(recomputed.stdout.trim()).toBe('recomputed reminder')
  })

  test('shows priming prompt from argv tail', async () => {
    const fixture = await setupSelfFixture()
    const result = runAsp(['self', 'prompt', 'priming', '--json'], fixture.env)

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      which: string
      content: string
      source: string
    }
    expect(parsed.which).toBe('priming')
    expect(parsed.content).toBe('test-priming')
    expect(parsed.source).toContain('launch argv')
  })

  test('rejects --sections for priming', async () => {
    const fixture = await setupSelfFixture()
    const result = runAsp(['self', 'prompt', 'priming', '--sections'], fixture.env)

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--sections is only supported for system and reminder')
  })
})
