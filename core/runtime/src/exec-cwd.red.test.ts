/**
 * T-12023: exec sections run in the project root when one is known, so a
 * `when.exists` predicate and the exec it gates see the same folder. Without a
 * project they fall back to agentRoot; an explicit execCwd still wins.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseContextTemplate } from './context-template.js'
import {
  type ResolverRoots,
  createResolverRoots,
  inspectTemplate,
  removeResolverRoots,
  resolveDetailed,
} from './test-support/context-resolver-fixture.js'

const TEMPLATE = `
schema_version = 2

[[reminder]]
name = "project-tooling"
type = "exec"
command = "printf 'cwd=%s' \\"$(pwd -P)\\""
when = { exists = "justfile" }
`

describe('exec section working directory (T-12023)', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
    await writeFile(join(roots.projectRoot, 'justfile'), 'info:\n\t@echo project\n')
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test('a when.exists-gated exec runs in the project root', async () => {
    const inspection = await inspectTemplate(roots, TEMPLATE)

    expect(inspection.reminder.content).toBe(`cwd=${await realpath(roots.projectRoot)}`)
  })

  test('without a project the exec falls back to agentRoot', async () => {
    const inspection = await inspectTemplate(roots, TEMPLATE, { projectRoot: undefined })

    expect(inspection.reminder.content).toBe(`cwd=${await realpath(roots.agentRoot)}`)
  })

  test('an explicit execCwd still wins over the project root', async () => {
    const pinned = join(roots.tempRoot, 'pinned')
    await mkdir(pinned)

    const resolved = await resolveDetailed(roots, parseContextTemplate(TEMPLATE), {
      execCwd: pinned,
    })

    expect(resolved.reminder).toBe(`cwd=${await realpath(pinned)}`)
  })
})
