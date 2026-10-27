import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DefaultResourceLoader } from '@mariozechner/pi-coding-agent'
import type { ExtensionFactory, Skill } from '@mariozechner/pi-coding-agent'

import { buildResourceLoaderOptions } from './pi-session.js'

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

// A factory is opaque to the loader options builder.
const extA = (() => ({})) as unknown as ExtensionFactory
const extB = (() => ({})) as unknown as ExtensionFactory

describe('INVARIANT: every supplied resource is visible through the loader after reload()', () => {
  function tmp(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix))
  }

  test('runner-shaped inputs (bundle extensions/skills/context) all surface via reload()', async () => {
    const resolved = { cwd: tmp('pi-run-cwd-'), agentDir: tmp('pi-run-agent-') }
    const opts = buildResourceLoaderOptions(
      {
        extensions: [extA, extB],
        skills: [skill('bundle-skill')],
        contextFiles: [{ path: 'BUNDLE.md', content: 'bundle' }],
      },
      resolved
    )
    expect(opts).toBeDefined()
    const loader = new DefaultResourceLoader(opts!)
    await loader.reload()
    expect(loader.getExtensions().extensions.length).toBeGreaterThanOrEqual(2)
    expect(loader.getSkills().skills.map((s) => s.name)).toContain('bundle-skill')
    expect(loader.getAgentsFiles().agentsFiles.map((f) => f.path)).toContain('BUNDLE.md')
  })
})
