import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { cleanupTempDirs, runAsp, setupSelfFixture } from './test-helpers.js'

afterEach(async () => {
  await cleanupTempDirs()
})

describe('asp self explain', () => {
  test('explains append mode and shared template winner for prompt diagnostics', async () => {
    const fixture = await setupSelfFixture({
      template: `
schema_version = 2
mode = "append"

[[prompt]]
name = "alpha"
type = "inline"
content = "alpha body"
`.trimStart(),
    })

    const result = runAsp(['self', 'explain', 'prompt'], fixture.env)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('append mode')
    expect(result.stdout).toContain('shared agents root')
  })

  test('explains empty reminder sections when the template resolves nothing', async () => {
    const fixture = await setupSelfFixture({
      template: `
schema_version = 2
mode = "append"

[[reminder]]
name = "session-context"
type = "slot"
source = "session.additionalContext"
`.trimStart(),
    })

    const result = runAsp(['self', 'explain', 'reminder', '--json'], fixture.env)

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      topic: string
      findings: Array<{ level: string; message: string }>
    }
    expect(parsed.topic).toBe('reminder')
    expect(
      parsed.findings.some((finding) => finding.message.includes('re-resolves an empty reminder'))
    ).toBe(true)
    expect(parsed.findings.some((finding) => finding.message.includes('session-context'))).toBe(
      true
    )
  })

  test('surfaces unreadable launch-file errors', async () => {
    const fixture = await setupSelfFixture()
    const env = { ...fixture.env, HRC_LAUNCH_FILE: join(fixture.dir, 'missing-launch.json') }
    const result = runAsp(['self', 'explain', 'launch'], env)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('could not be read')
    expect(result.stdout).toContain('missing-launch.json')
  })
})
