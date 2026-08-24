import { afterEach, describe, expect, test } from 'bun:test'

import { analyzeTemplateSections, resolveSelfContext, resolveSelfTemplateContext } from '../lib.js'
import { cleanupTempDirs, setupSelfFixture } from './test-helpers.js'

afterEach(async () => {
  await cleanupTempDirs()
})

describe('self/lib section analysis', () => {
  test('reports included and excluded prompt sections with when metadata', async () => {
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

    const ctx = resolveSelfContext({
      env: fixture.env,
      aspHome: fixture.dir,
      agentsRoot: fixture.agentsRoot,
      cwd: fixture.dir,
    })
    const templateCtx = resolveSelfTemplateContext(ctx)
    expect(templateCtx.template).not.toBeNull()

    const reports = await analyzeTemplateSections({
      template: templateCtx.template!,
      resolverContext: templateCtx.resolverContext,
      zone: 'prompt',
    })

    expect(reports.find((report) => report.name === 'alpha')?.included).toBe(true)
    const heartbeat = reports.find((report) => report.name === 'heartbeat')
    expect(heartbeat?.included).toBe(false)
    expect(heartbeat?.when).toContain('runMode=heartbeat')
  })
})
