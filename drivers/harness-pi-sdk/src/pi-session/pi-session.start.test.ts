import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as realPi from '@mariozechner/pi-coding-agent'
import type { Skill } from '@mariozechner/pi-coding-agent'

// Capture the options createAgentSession is called with, while keeping every
// other export (AuthStorage / ModelRegistry / SessionManager / DefaultResourceLoader)
// REAL so PiSession.start() builds and reloads a genuine resource loader.
let captured: { resourceLoader?: unknown } | undefined

mock.module('@mariozechner/pi-coding-agent', () => ({
  ...realPi,
  createAgentSession: async (options: { resourceLoader?: unknown }) => {
    captured = options
    return {
      session: { subscribe: () => () => {}, abort: () => {} },
      extensionsResult: {},
    }
  },
}))

const { PiSession } = await import('./pi-session.js')
type PiSessionConfig = ConstructorParameters<typeof PiSession>[0]

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function skill(name: string): Skill {
  return {
    name,
    description: `desc-${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { source: 'test' } as unknown as Skill['sourceInfo'],
    disableModelInvocation: false,
  }
}

const ext = (() => ({})) as unknown as NonNullable<PiSessionConfig['extensions']>[number]

describe('PiSession.start() resource wiring', () => {
  beforeEach(() => {
    captured = undefined
  })

  afterAll(() => {
    mock.restore()
  })

  test('passes a resourceLoader whose reload() surfaces every supplied resource', async () => {
    const config: PiSessionConfig = {
      ownerId: 'owner',
      cwd: tmp('pi-start-cwd-'),
      persistSessions: false,
      systemPrompt: 'SYS-PROMPT',
      extensions: [ext],
      additionalExtensionPaths: [],
      skills: [skill('cfg-skill')],
      contextFiles: [{ path: 'CTX.md', content: 'ctx' }],
    }
    const session = new PiSession(config)
    await session.start({ skills: [skill('start-skill')] })

    expect(captured).toBeDefined()
    const loader = captured?.resourceLoader as InstanceType<typeof realPi.DefaultResourceLoader>
    expect(loader).toBeDefined()
    // The loader has already been reload()ed inside start().
    expect(loader.getSystemPrompt()).toBe('SYS-PROMPT')
    expect(loader.getSkills().skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['cfg-skill', 'start-skill'])
    )
    expect(loader.getAgentsFiles().agentsFiles.map((f) => f.path)).toContain('CTX.md')
    expect(loader.getExtensions().extensions.length).toBeGreaterThanOrEqual(1)
  })

  test('no-resource regression: default startup passes NO resourceLoader (Pi normal discovery)', async () => {
    const config: PiSessionConfig = {
      ownerId: 'owner',
      cwd: tmp('pi-start-bare-'),
      persistSessions: false,
    }
    const session = new PiSession(config)
    await session.start()

    expect(captured).toBeDefined()
    expect(captured?.resourceLoader).toBeUndefined()
  })
})
