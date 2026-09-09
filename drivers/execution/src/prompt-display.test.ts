import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'

import { decodeForDisplay, renderSection } from './prompt-display.js'

// Render without SGR escapes so the assertions below read the visible text
// rather than chalk's colour codes, whatever the runner's TTY detection says.
chalk.level = 0

const SECTION_SEPARATOR = '\n\n---\n\n'

/** The content between a framed section's top rule and its footer, gutter removed. */
function body(lines: string[]): string {
  const start = lines.findIndex((l) => l.startsWith('┌'))
  const end = lines.findIndex((l) => l.startsWith('└'))
  return lines
    .slice(start + 1, end)
    .filter((l) => l !== '│')
    .map((l) => l.slice('│  '.length))
    .join('\n')
}

function footer(lines: string[]): string {
  return lines.find((l) => l.startsWith('└')) ?? ''
}

describe('decodeForDisplay', () => {
  test('decodes a lone content envelope to the markdown it carries', () => {
    const markdown = '<task_tracking_rules>\n# Heading\n\n- bullet "quoted"\n'
    expect(decodeForDisplay(JSON.stringify({ content: markdown }))).toBe(markdown)
  })

  test('decodes an envelope section and leaves its siblings byte-for-byte', () => {
    const markdown = '# wrkq\n\nline two'
    const siblings = ['## Ready promises\n\n- PR-00008', '## Agent memory\n\n- a note']
    const joined = [JSON.stringify({ content: markdown }), ...siblings].join(SECTION_SEPARATOR)

    expect(decodeForDisplay(joined)).toBe([markdown, ...siblings].join(SECTION_SEPARATOR))
  })

  test.each([
    ['plain markdown', '## Ready promises\n\n- PR-00008'],
    ['an extra key', '{"content":"x","other":1}'],
    ['a non-string content', '{"content": 42}'],
    ['an object content', '{"content": {"a": 1}}'],
    ['a different key', '{"data": "x"}'],
    ['an array wrapper', '[{"content":"x"}]'],
    ['malformed JSON', '{"content": "x"'],
    ['an empty object', '{}'],
    ['a JSON null', 'null'],
    ['prose that mentions the shape', 'The hook emits {"content": "…"} when piped.'],
    ['a fenced code block showing the shape', '```json\n{"content":"x"}\n```'],
    ['bare braces', '{ not json at all }'],
  ])('renders %s verbatim', (_label, content) => {
    expect(decodeForDisplay(content)).toBe(content)
  })
})

describe('renderSection', () => {
  const section = (content: string) => ({
    title: 'Session Reminder',
    content,
    color: (text: string) => text,
  })

  test('prints the decoded markdown, with no escape artifacts left', () => {
    const markdown = '<task_tracking_rules>\n# wrkq\n\n- "quoted"'
    const rendered = renderSection(section(JSON.stringify({ content: markdown })))

    expect(body(rendered)).toBe(markdown)
    expect(body(rendered)).not.toContain('\\n')
    expect(body(rendered)).not.toContain('\\u003c')
  })

  test('reports the undecoded size so budget comparisons do not move', () => {
    const markdown = '# wrkq\n\nline two'
    const envelope = JSON.stringify({ content: markdown })
    expect(envelope.length).not.toBe(markdown.length)

    const rendered = renderSection({
      ...section(envelope),
      sectionSizes: [`reminder.wrkq-context=${envelope.length}`],
    })

    expect(footer(rendered)).toContain(`${envelope.length.toLocaleString()} chars`)
    expect(footer(rendered)).toContain(`reminder.wrkq-context=${envelope.length}`)
    expect(footer(rendered)).not.toContain(`${markdown.length.toLocaleString()} chars`)
  })

  test('leaves a section that carries no envelope untouched', () => {
    const content = '## Ready promises\n\n- PR-00008'
    const rendered = renderSection(section(content))

    expect(body(rendered)).toBe(content)
    expect(footer(rendered)).toContain(`${content.length} chars`)
  })
})
