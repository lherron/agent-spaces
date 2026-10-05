/**
 * `when` predicate gating in the context resolver: a section renders only when
 * every declared condition holds against the resolver's cwd and env source.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseContextTemplate } from './context-template.js'
import {
  type ResolverRoots,
  SECTION_SEPARATOR,
  createResolverRoots,
  removeResolverRoots,
  resolveZones,
} from './test-support/context-resolver-fixture.js'

describe('resolveContextTemplate when predicates', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test('gates sections on when.exists using the real cwd', async () => {
    await writeFile(join(roots.projectRoot, 'justfile'), 'default:\n\t@echo ok\n')

    const resolved = await resolveZones(
      roots,
      parseContextTemplate(`
schema_version = 2

[[reminder]]
name = "project-tooling"
type = "inline"
content = "Just is available"
when = { exists = "justfile" }

[[reminder]]
name = "missing-tooling"
type = "inline"
content = "Should not render"
when = { exists = "missing.file" }
`)
    )

    expect(resolved).toEqual({
      prompt: undefined,
      reminder: 'Just is available',
    })
  })

  test.each([
    {
      title: 'gates sections on when.envSet using the resolver env source',
      sections: [
        ['set', '{ envSet = "ASP_TEST_PRESENT" }'],
        ['unset', '{ envSet = "ASP_TEST_MISSING" }'],
        ['whitespace', '{ envSet = "ASP_TEST_WHITESPACE" }'],
      ],
      env: { ASP_TEST_PRESENT: 'value', ASP_TEST_WHITESPACE: '   ' },
      expected: 'set body',
    },
    {
      title: 'gates sections on when.envEquals with exact untrimmed match',
      sections: [
        ['match', '{ envEquals = { name = "ASP_TEST_VAR", value = "yes" } }'],
        ['miss', '{ envEquals = { name = "ASP_TEST_VAR", value = "no" } }'],
        ['untrimmed', '{ envEquals = { name = "ASP_TEST_PADDED", value = "yes" } }'],
      ],
      env: { ASP_TEST_VAR: 'yes', ASP_TEST_PADDED: ' yes ' },
      expected: 'match body',
    },
    {
      title: 'gates sections on when.envNotEquals with exact untrimmed match',
      sections: [
        ['absent', '{ envNotEquals = { name = "ASP_MISSING", value = "1" } }'],
        ['different', '{ envNotEquals = { name = "ASP_OTHER", value = "1" } }'],
        ['matching', '{ envNotEquals = { name = "ASP_OVERLAY", value = "1" } }'],
      ],
      env: { ASP_OVERLAY: '1', ASP_OTHER: '0' },
      expected: `absent body${SECTION_SEPARATOR}different body`,
    },
  ])('$title', async ({ sections, env, expected }) => {
    const toml = sections
      .map(
        ([name, when]) => `
[[prompt]]
name = "${name}"
type = "inline"
content = "${name} body"
when = ${when}
`
      )
      .join('')

    const resolved = await resolveZones(
      roots,
      parseContextTemplate(`schema_version = 2\n${toml}`),
      {
        env,
      }
    )

    expect(resolved.prompt?.content).toBe(expected)
  })
})
