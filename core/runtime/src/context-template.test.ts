/**
 * Red/green ownership for wrkq T-01042.
 *
 * Spec source: PROMPT_TEMPLATE_UPDATES.md, "v2 Template Format" and
 * "Parser tests (context-template.test.ts)".
 *
 * A malformed context-template.toml is rejected when the system prompt is
 * inspected, and the error names the template file and the offending field.
 * The well-formed grammar (zones, wrap tables, per-section max_chars, when
 * predicates, slots) is exercised by the context-resolver-*.test.ts files,
 * which author their templates as TOML through the same entry point.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  type ResolverRoots,
  createResolverRoots,
  inspectTemplate,
  removeResolverRoots,
} from './test-support/context-resolver-fixture.js'

function inlineSection(zone: 'prompt' | 'reminder', extra: string): string {
  return `
schema_version = 2

[[${zone}]]
name = "x"
type = "inline"
content = "body"
${extra}
`
}

function wrapSection(zone: 'prompt' | 'reminder', wrapLines: string): string {
  return inlineSection(zone, `\n[${zone}.wrap]\n${wrapLines}`)
}

describe('parseContextTemplate', () => {
  let roots: ResolverRoots

  beforeEach(async () => {
    roots = await createResolverRoots()
  })

  afterEach(async () => {
    await removeResolverRoots(roots)
  })

  test.each([
    [
      'schema_version 1',
      'schema_version = 1\n\n[[section]]\nname = "platform"\ntype = "file"\npath = "platform-prompt.md"\n',
      'schema_version must be 2, received 1',
    ],
    [
      'a v1 [[section]] header in a v2 template',
      'schema_version = 2\n\n[[section]]\nname = "platform"\ntype = "file"\npath = "AGENT_MOTD.md"\n',
      'does not support [[section]]; use [[prompt]] and [[reminder]]',
    ],
    [
      'a non-positive top-level max_chars',
      'schema_version = 2\nmax_chars = 0\n',
      'Context template max_chars must be a positive integer, received 0',
    ],
    [
      'a non-integer top-level max_chars',
      'schema_version = 2\nmax_chars = 1.5\n',
      'Context template max_chars must be a positive integer, received 1.5',
    ],
    [
      'a non-positive section max_chars',
      'schema_version = 2\n\n[[prompt]]\nname = "services"\ntype = "exec"\ncommand = "stackctl status dev --brief"\nmax_chars = -1\n',
      'prompt[1].max_chars must be a positive integer, received -1',
    ],
    [
      'a non-integer section max_chars',
      'schema_version = 2\n\n[[reminder]]\nname = "project-tooling"\ntype = "exec"\ncommand = "just info"\nmax_chars = 9.1\n',
      'reminder[1].max_chars must be a positive integer, received 9.1',
    ],
    [
      'a slot section without a source',
      'schema_version = 2\n\n[[prompt]]\nname = "additional-base"\ntype = "slot"\n',
      'prompt[1] (additional-base).source must be a non-empty string',
    ],
    [
      'a non-string when.exists',
      'schema_version = 2\n\n[[reminder]]\nname = "project-tooling"\ntype = "exec"\ncommand = "just info"\nwhen = { exists = true }\n',
      'reminder[1].when.exists must be a string, received true',
    ],
    [
      'an unknown when predicate key',
      'schema_version = 2\n\n[[prompt]]\nname = "platform"\ntype = "file"\npath = "AGENT_MOTD.md"\nwhen = { runMode = "heartbeat", branch = "main" }\n',
      'prompt[1].when.branch is not supported',
    ],
    [
      'an unknown when.taskField',
      inlineSection('prompt', 'when = { taskField = "owner" }'),
      'prompt[1].when.taskField must be one of id, phase, role, requiredEvidence, hints, received "owner"',
    ],
    [
      'an array where the when table belongs',
      inlineSection('prompt', 'when = []'),
      'prompt[1].when must be a TOML table, received an array',
    ],
    [
      'a section declaring both content and parts',
      inlineSection('prompt', 'parts = [{ content = "b" }]'),
      'prompt[1] (x) must declare either content or parts, not both',
    ],
    [
      'an unsupported wrap key indent',
      wrapSection('prompt', 'prefix = ">"\nindent = "left"'),
      'prompt[1].wrap.indent is not supported; only prefix and suffix are allowed',
    ],
    [
      'an unsupported wrap key align',
      wrapSection('prompt', 'prefix = ">"\nalign = "left"'),
      'prompt[1].wrap.align is not supported; only prefix and suffix are allowed',
    ],
    [
      'a numeric wrap prefix',
      wrapSection('reminder', 'prefix = 42'),
      'reminder[1].wrap.prefix must be a string, received 42',
    ],
    [
      'an array wrap suffix',
      wrapSection('reminder', 'suffix = ["a", "b"]'),
      'reminder[1].wrap.suffix must be a string, received an array',
    ],
    [
      'a table wrap prefix',
      wrapSection('reminder', 'prefix = { text = "heading" }'),
      'reminder[1].wrap.prefix must be a string, received an object',
    ],
  ])(
    'a malformed context template is rejected naming the offending field: %s',
    async (_label, templateToml, offendingField) => {
      const error = await inspectTemplate(roots, templateToml).then(
        () => undefined,
        (rejected: unknown) => rejected
      )

      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      expect(message).toContain(`Invalid system prompt template at ${roots.agentsRoot}`)
      expect(message).toContain(offendingField)
    }
  )
})
