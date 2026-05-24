import { describe, expect, test } from 'bun:test'
import * as contracts from '../src/index'

const createCanonicalHasher = (contracts as any).createCanonicalHasher as
  | (() => contracts.CanonicalHasher)
  | undefined
const redactValue = (contracts as any).redactValue as
  | ((value: unknown, options?: { env?: Record<string, string | undefined> }) => unknown)
  | undefined
const redactArtifact = (contracts as any).redactArtifact as
  | (<T>(
      value: T,
      options?: { env?: Record<string, string | undefined> },
    ) => contracts.RedactedArtifact<unknown>)
  | undefined

function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

describe('redaction helpers', () => {
  test('redactValue removes env-secret values and bearer/token patterns', () => {
    expect(redactValue, 'redactValue must be exported').toBeFunction()

    const payload = {
      env: {
        OPENAI_API_KEY: 'sk-live-super-secret',
        ORDINARY_VALUE: 'visible',
      },
      command: 'curl -H "Authorization: Bearer bearer-token-123" https://example.test',
      nested: {
        npm: '//registry.npmjs.org/:_authToken=npm-token-123',
      },
    }

    const redacted = redactValue(payload, {
      env: {
        OPENAI_API_KEY: 'sk-live-super-secret',
      },
    })
    const serialized = stableStringify(redacted)

    expect(serialized).not.toContain('sk-live-super-secret')
    expect(serialized).not.toContain('bearer-token-123')
    expect(serialized).not.toContain('npm-token-123')
    expect(serialized).toContain('visible')
    expect(serialized).toContain('[REDACTED')
  })

  test('redactArtifact hash matches recomputed hash of the redacted value', () => {
    expect(redactArtifact, 'redactArtifact must be exported').toBeFunction()
    expect(createCanonicalHasher, 'createCanonicalHasher must be exported').toBeFunction()

    const artifact = redactArtifact(
      {
        env: {
          OPENAI_API_KEY: 'sk-live-super-secret',
          ORDINARY_VALUE: 'visible',
        },
        args: ['--token', 'cli-token-123'],
      },
      {
        env: {
          OPENAI_API_KEY: 'sk-live-super-secret',
        },
      },
    )

    const recomputed = createCanonicalHasher().hash(artifact.value, {
      secretMode: 'redacted-placeholder',
      timestampMode: 'include-semantic',
    })

    expect(artifact.schemaVersion).toBe('redacted-artifact/v1')
    expect(artifact.redactionState).toBe('redacted')
    expect(artifact.hash).toBe(recomputed.value)
    expect(stableStringify(artifact.value)).not.toContain('sk-live-super-secret')
    expect(stableStringify(artifact.value)).not.toContain('cli-token-123')
  })
})
