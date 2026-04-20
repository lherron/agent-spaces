/**
 * Red/green ownership for wrkq T-01042.
 *
 * Spec source: PROMPT_TEMPLATE_UPDATES.md, "v2 Template Format" and
 * "Parser tests (context-template.test.ts)".
 * These tests intentionally define the parser contract before implementation
 * exists so future sessions can verify the requested v1/v2 behavior and errors.
 */

import { describe, expect, test } from 'bun:test'
import { parseContextTemplate } from './context-template.js'

describe('parseContextTemplate', () => {
  test('parses v2 prompt and reminder sections into separate arrays', () => {
    const template = parseContextTemplate(`
schema_version = 2
mode = "append"
max_chars = 10000

[[prompt]]
name = "platform"
type = "file"
path = "AGENT_MOTD.md"

[[prompt]]
name = "inline-prompt"
type = "inline"
content = "Prompt inline"

[[prompt]]
name = "prompt-exec"
type = "exec"
command = "date '+Today is %Y-%m-%d.'"
timeout = 3000

[[prompt]]
name = "prompt-slot"
type = "slot"
source = "instructions.additionalBase"

[[reminder]]
name = "reminder-file"
type = "file"
path = "project-root:///README.md"

[[reminder]]
name = "reminder-inline"
type = "inline"
content = "Reminder inline"

[[reminder]]
name = "reminder-exec"
type = "exec"
command = "just info 2>/dev/null"
timeout = 1500

[[reminder]]
name = "reminder-slot"
type = "slot"
source = "session.additionalContext"
`)

    expect(template).toEqual({
      schemaVersion: 2,
      mode: 'append',
      maxChars: 10000,
      promptSections: [
        {
          name: 'platform',
          type: 'file',
          path: 'AGENT_MOTD.md',
        },
        {
          name: 'inline-prompt',
          type: 'inline',
          content: 'Prompt inline',
        },
        {
          name: 'prompt-exec',
          type: 'exec',
          command: "date '+Today is %Y-%m-%d.'",
          timeout: 3000,
        },
        {
          name: 'prompt-slot',
          type: 'slot',
          source: 'instructions.additionalBase',
        },
      ],
      reminderSections: [
        {
          name: 'reminder-file',
          type: 'file',
          path: 'project-root:///README.md',
        },
        {
          name: 'reminder-inline',
          type: 'inline',
          content: 'Reminder inline',
        },
        {
          name: 'reminder-exec',
          type: 'exec',
          command: 'just info 2>/dev/null',
          timeout: 1500,
        },
        {
          name: 'reminder-slot',
          type: 'slot',
          source: 'session.additionalContext',
        },
      ],
    })
  })

  test('rejects schema_version 1 templates', () => {
    expect(() =>
      parseContextTemplate(`
schema_version = 1

[[section]]
name = "platform"
type = "file"
path = "platform-prompt.md"
`)
    ).toThrow(/schema_version.*2/i)
  })

  test('rejects section headers in v2 templates', () => {
    expect(() =>
      parseContextTemplate(`
schema_version = 2

[[section]]
name = "platform"
type = "file"
path = "AGENT_MOTD.md"
`)
    ).toThrow(/section|prompt|reminder/i)
  })

  test.each([
    [
      'rejects non-positive top-level max_chars',
      `
schema_version = 2
max_chars = 0
`,
    ],
    [
      'rejects non-integer top-level max_chars',
      `
schema_version = 2
max_chars = 1.5
`,
    ],
    [
      'rejects non-positive section max_chars',
      `
schema_version = 2

[[prompt]]
name = "services"
type = "exec"
command = "stackctl status dev --brief"
max_chars = -1
`,
    ],
    [
      'rejects non-integer section max_chars',
      `
schema_version = 2

[[reminder]]
name = "project-tooling"
type = "exec"
command = "just info"
max_chars = 9.1
`,
    ],
  ])('%s', (_label, input) => {
    expect(() => parseContextTemplate(input)).toThrow(/max_chars/i)
  })

  test('requires source for v2 slot sections', () => {
    expect(() =>
      parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "additional-base"
type = "slot"
`)
    ).toThrow(/source/i)
  })

  test('validates when.exists is a string', () => {
    expect(() =>
      parseContextTemplate(`
schema_version = 2

[[reminder]]
name = "project-tooling"
type = "exec"
command = "just info"
when = { exists = true }
`)
    ).toThrow(/exists/i)
  })

  test('rejects unknown when predicate keys', () => {
    expect(() =>
      parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "platform"
type = "file"
path = "AGENT_MOTD.md"
when = { runMode = "heartbeat", branch = "main" }
`)
    ).toThrow(/when|branch/i)
  })

  test('accepts empty prompt and reminder arrays', () => {
    const template = parseContextTemplate(`
schema_version = 2
mode = "replace"
`)

    expect(template).toEqual({
      schemaVersion: 2,
      mode: 'replace',
      promptSections: [],
      reminderSections: [],
    })
  })

  test('stores per-section max_chars in both prompt and reminder zones', () => {
    const template = parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "services"
type = "exec"
command = "stackctl status dev --brief"
max_chars = 600

[[reminder]]
name = "wrkq-context"
type = "exec"
command = "wrkq agent-info"
max_chars = 250
`)

    expect(template.promptSections).toEqual([
      {
        name: 'services',
        type: 'exec',
        command: 'stackctl status dev --brief',
        maxChars: 600,
      },
    ])

    expect(template.reminderSections).toEqual([
      {
        name: 'wrkq-context',
        type: 'exec',
        command: 'wrkq agent-info',
        maxChars: 250,
      },
    ])
  })

  test('parses when predicates with runMode and exists', () => {
    const template = parseContextTemplate(`
schema_version = 2

[[prompt]]
name = "heartbeat"
type = "file"
path = "agent-root:///HEARTBEAT.md"
when = { runMode = "heartbeat" }

[[reminder]]
name = "project-tooling"
type = "exec"
command = "just info"
when = { exists = "justfile" }
`)

    expect(template.promptSections).toEqual([
      {
        name: 'heartbeat',
        type: 'file',
        path: 'agent-root:///HEARTBEAT.md',
        when: {
          runMode: 'heartbeat',
        },
      },
    ])

    expect(template.reminderSections).toEqual([
      {
        name: 'project-tooling',
        type: 'exec',
        command: 'just info',
        when: {
          exists: 'justfile',
        },
      },
    ])
  })
})
