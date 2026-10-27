/**
 * Shared-file refs in context template file sections (T-04143): the explicit
 * `agents-root:///` scheme resolves through the same overlay-first agent-root
 * search path as bare-relative shared files (T-04141). Templates are real
 * context-template.toml files resolved through inspectAgentSystemPrompt.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ResolverRoots,
  createResolverRoots,
  inspectTemplate,
  removeResolverRoots,
} from './test-support/context-resolver-fixture.js'

function fileSectionTemplate(name: string, path: string, required: boolean): string {
  return `
schema_version = 2

[[prompt]]
name = "${name}"
type = "file"
path = "${path}"
required = ${required}
`
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

  // T-04143 red/green gate: agents-root:/// is explicit shared-file syntax,
  // but it must still resolve through the same overlay-first search path as
  // T-04141 bare-relative shared files.
  test.each([
    { label: 'the overlay has the file', overlay: 'local motd', expected: 'local motd' },
    {
      label: 'only the canonical root has the file',
      overlay: undefined,
      expected: 'canonical motd',
    },
  ])(
    'T-04143 agents-root:/// resolves overlay-first when $label',
    async ({ overlay, expected }) => {
      if (overlay !== undefined) {
        await writeFile(join(localAgentsRoot, 'AGENT_MOTD.md'), overlay)
      }
      await writeFile(join(roots.agentsRoot, 'AGENT_MOTD.md'), 'canonical motd')

      const inspection = await inspectTemplate(
        roots,
        fileSectionTemplate('motd', 'agents-root:///AGENT_MOTD.md', true),
        overlayFirst()
      )

      expect(inspection.prompt).toMatchObject({ content: expected, mode: 'replace' })
      expect(inspection.reminder.content).toBeUndefined()
    }
  )

  test('T-04143 a missing agents-root:/// file is skipped when optional and fails the template when required', async () => {
    const optional = await inspectTemplate(
      roots,
      fileSectionTemplate('optional-missing', 'agents-root:///missing.md', false),
      overlayFirst()
    )
    expect(optional.prompt.content).toBe('')
    expect(optional.reminder.content).toBeUndefined()
    expect(optional.prompt.sections[0]).toMatchObject({
      name: 'optional-missing',
      included: false,
    })

    await expect(
      inspectTemplate(
        roots,
        fileSectionTemplate('required-missing', 'agents-root:///missing.md', true),
        overlayFirst()
      )
    ).rejects.toThrow(/missing\.md/)
  })
})
