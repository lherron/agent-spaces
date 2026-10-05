/**
 * Shared-file refs in context template file sections (T-04143): the explicit
 * `agents-root:///` scheme resolves through the same overlay-first agent-root
 * search path as bare-relative shared files (T-04141).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseContextTemplate } from './context-template.js'
import {
  type ResolverRoots,
  createResolverRoots,
  removeResolverRoots,
  resolveZones,
} from './test-support/context-resolver-fixture.js'

function fileSectionTemplate(name: string, path: string, required: boolean) {
  return parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "${name}"
type = "file"
path = "${path}"
required = ${required}
`)
}

describe('resolveContextTemplate shared-file refs', () => {
  let roots: ResolverRoots
  let localAgentsRoot: string

  beforeEach(async () => {
    roots = await createResolverRoots()
    localAgentsRoot = join(roots.projectRoot, 'agents')
    await mkdir(localAgentsRoot, { recursive: true })
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  function overlayFirst() {
    return { agentRootSearchPath: [localAgentsRoot, roots.agentsRoot] }
  }

  test('T-04143 resolves agents-root scheme through the overlay-first agent-root search path', async () => {
    await writeFile(join(localAgentsRoot, 'AGENT_MOTD.md'), 'local motd')
    await writeFile(join(roots.agentsRoot, 'AGENT_MOTD.md'), 'canonical motd')

    const resolved = await resolveZones(
      roots,
      fileSectionTemplate('motd', 'agents-root:///AGENT_MOTD.md', true),
      overlayFirst()
    )

    // T-04143 red/green gate: agents-root:/// is explicit shared-file syntax,
    // but it must still resolve through the same overlay-first search path as
    // T-04141 bare-relative shared files.
    expect(resolved).toEqual({
      prompt: { content: 'local motd', mode: 'replace' },
      reminder: undefined,
    })
  })

  test('T-04143 agents-root scheme falls back to canonical when the overlay has no file', async () => {
    await writeFile(join(roots.agentsRoot, 'AGENT_MOTD.md'), 'canonical motd')

    const resolved = await resolveZones(
      roots,
      fileSectionTemplate('motd', 'agents-root:///AGENT_MOTD.md', true),
      overlayFirst()
    )

    expect(resolved).toEqual({
      prompt: { content: 'canonical motd', mode: 'replace' },
      reminder: undefined,
    })
  })

  test('T-04143 agents-root scheme keeps required and non-required not-found behavior', async () => {
    const optional = await resolveZones(
      roots,
      fileSectionTemplate('optional-missing', 'agents-root:///missing.md', false),
      overlayFirst()
    )
    expect(optional).toEqual({ prompt: undefined, reminder: undefined })

    await expect(
      resolveZones(
        roots,
        fileSectionTemplate('required-missing', 'agents-root:///missing.md', true),
        overlayFirst()
      )
    ).rejects.toThrow(/missing\.md/)
  })

  test('T-04143 keeps bare-relative shared-file fallback semantics unchanged', async () => {
    await writeFile(join(localAgentsRoot, 'AGENT_MOTD.md'), 'local motd')
    await writeFile(join(roots.agentsRoot, 'AGENT_MOTD.md'), 'canonical motd')

    const resolved = await resolveZones(
      roots,
      fileSectionTemplate('motd', 'AGENT_MOTD.md', true),
      overlayFirst()
    )

    expect(resolved).toEqual({
      prompt: { content: 'local motd', mode: 'replace' },
      reminder: undefined,
    })
  })
})
