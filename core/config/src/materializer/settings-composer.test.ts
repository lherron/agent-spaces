import { describe, expect, it } from 'bun:test'
import { composeSettings, isEmptySettings } from './settings-composer.js'

describe('composeSettings', () => {
  it('passes through cleanupPeriodDays with the last defined value winning', () => {
    const composed = composeSettings([
      {
        spaceId: 'defaults',
        settings: { cleanupPeriodDays: 30 },
      },
      {
        spaceId: 'without-cleanup-period',
        settings: { model: 'sonnet' },
      },
      {
        spaceId: 'retention-override',
        settings: { cleanupPeriodDays: 36500 },
      },
    ])

    expect(composed.cleanupPeriodDays).toBe(36500)
    expect(isEmptySettings(composed)).toBe(false)
  })
})
