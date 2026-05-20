import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../errors'

const SAFE_INHERITED_ENV = [
  'HOME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'USERNAME',
] as const

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function buildProcessEnv(specEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const key of SAFE_INHERITED_ENV) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }

  for (const [key, value] of Object.entries(specEnv ?? {})) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new BrokerError(BrokerErrorCode.ResourceError, `Invalid environment key: ${key}`, {
        key,
      })
    }
    env[key] = value
  }

  return env
}
