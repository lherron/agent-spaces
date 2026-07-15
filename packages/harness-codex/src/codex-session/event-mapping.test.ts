import { describe, expect, test } from 'bun:test'
import { classifyNotification } from './event-mapping'

describe('classifyNotification — notice-shaped server notifications', () => {
  test('deprecationNotice becomes a warning notice using the provider summary', () => {
    expect(
      classifyNotification('deprecationNotice', {
        summary: 'The legacy_sandbox config key is deprecated.',
        details: 'Use sandbox_mode instead.',
      })
    ).toEqual([
      {
        type: 'notice',
        level: 'warn',
        message: 'The legacy_sandbox config key is deprecated.',
      },
    ])
  })

  test('configWarning becomes a warning notice using the provider summary', () => {
    expect(
      classifyNotification('configWarning', {
        summary: 'Ignored invalid value for model_reasoning_effort.',
        details: 'Expected low, medium, or high.',
      })
    ).toEqual([
      {
        type: 'notice',
        level: 'warn',
        message: 'Ignored invalid value for model_reasoning_effort.',
      },
    ])
  })

  test('windows/worldWritableWarning becomes a warning notice describing the structured warning', () => {
    const events = classifyNotification('windows/worldWritableWarning', {
      extraCount: 2,
      failedScan: true,
      samplePaths: ['C:\\Temp', 'C:\\Shared'],
    })

    expect(events).toHaveLength(1)
    expect(events?.[0]).toMatchObject({ type: 'notice', level: 'warn' })
    const message = (events?.[0] as { message: string }).message
    expect(message).toContain('world-writable')
    expect(message).toContain('C:\\Temp')
    expect(message).toContain('C:\\Shared')
    expect(message).toContain('2')
    expect(message).toMatch(/scan[^.]*fail|fail[^.]*scan/i)
  })

  test('a genuinely unknown notification remains unclassified', () => {
    expect(classifyNotification('thread/somethingNew', { foo: 1 })).toBeNull()
  })
})
