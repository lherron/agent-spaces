/**
 * Red/green ownership for wrkq T-01013.
 *
 * Spec source: SYSTEM_PROMPT_RESOLUTION.md, "Implementation plan" Step 1.
 * These tests intentionally define the parser contract before implementation
 * exists so future sessions can verify the exact requested shapes and errors.
 */

import { describe, expect, test } from 'bun:test'
import { parseSystemPromptTemplate } from './system-prompt-template.js'

describe('parseSystemPromptTemplate', () => {
  test('parses a valid template with all 4 section types', () => {
    const template = parseSystemPromptTemplate(`
schema_version = 1
mode = "append"

[[section]]
name = "platform"
type = "file"
path = "platform-prompt.md"
required = true

[[section]]
name = "inline-notice"
type = "inline"
content = "Inline content"

[[section]]
name = "environment"
type = "exec"
command = "date '+Today is %Y-%m-%d.'"
timeout = 7500

[[section]]
name = "scaffold"
type = "slot"
`)

    expect(template).toEqual({
      schemaVersion: 1,
      mode: 'append',
      sections: [
        {
          name: 'platform',
          type: 'file',
          path: 'platform-prompt.md',
          required: true,
        },
        {
          name: 'inline-notice',
          type: 'inline',
          content: 'Inline content',
        },
        {
          name: 'environment',
          type: 'exec',
          command: "date '+Today is %Y-%m-%d.'",
          timeout: 7500,
        },
        {
          name: 'scaffold',
          type: 'slot',
        },
      ],
    })
  })

  test('defaults mode to replace when omitted', () => {
    const template = parseSystemPromptTemplate(`
schema_version = 1

[[section]]
name = "additional-base"
type = "slot"
`)

    expect(template.mode).toBe('replace')
  })

  test('throws for invalid schema_version', () => {
    expect(() =>
      parseSystemPromptTemplate(`
schema_version = 2
`)
    ).toThrow(/schema_version/i)
  })

  test.each([
    [
      'file section without path',
      `
schema_version = 1

[[section]]
name = "platform"
type = "file"
`,
      /path/i,
    ],
    [
      'inline section without content',
      `
schema_version = 1

[[section]]
name = "inline-notice"
type = "inline"
`,
      /content/i,
    ],
    [
      'exec section without command',
      `
schema_version = 1

[[section]]
name = "environment"
type = "exec"
`,
      /command/i,
    ],
  ])('throws when required fields are missing: %s', (_label, input, expectedError) => {
    expect(() => parseSystemPromptTemplate(input)).toThrow(expectedError)
  })

  test('throws for an invalid slot name', () => {
    expect(() =>
      parseSystemPromptTemplate(`
schema_version = 1

[[section]]
name = "platform"
type = "slot"
`)
    ).toThrow(/slot/i)
  })

  test('parses when predicates correctly', () => {
    const template = parseSystemPromptTemplate(`
schema_version = 1

[[section]]
name = "heartbeat"
type = "file"
path = "agent-root:///HEARTBEAT.md"
when = { runMode = "heartbeat" }
`)

    expect(template.sections).toEqual([
      {
        name: 'heartbeat',
        type: 'file',
        path: 'agent-root:///HEARTBEAT.md',
        when: {
          runMode: 'heartbeat',
        },
      },
    ])
  })

  test('accepts an empty sections array', () => {
    const template = parseSystemPromptTemplate(`
schema_version = 1
mode = "replace"
`)

    expect(template).toEqual({
      schemaVersion: 1,
      mode: 'replace',
      sections: [],
    })
  })
})
