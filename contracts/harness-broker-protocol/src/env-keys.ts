/**
 * Environment-key classification policy.
 *
 * These are env POLICY (which keys are ambient / credential / reserved), not
 * wire-DTO validation. They are consumed both by this package's DTO validators
 * (schemas.ts) and cross-package by the harness broker runtime env builder.
 *
 * Extracted from schemas.ts (behavior-preserving). Re-exported from schemas.ts
 * so the public package surface is unchanged.
 */

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export const AMBIENT_ENV_KEYS = new Set([
  'HOME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'USERNAME',
  'TERM',
  'LANG',
  'TZ',
])
export const CREDENTIAL_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
])
export const RESERVED_ENV_KEY_PREFIXES = ['NODE_', 'npm_', 'NPM_', 'XDG_']
export const RESERVED_ENV_KEYS = new Set([
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
])

export function isAmbientEnvKey(key: string): boolean {
  return AMBIENT_ENV_KEYS.has(key) || key.startsWith('LC_')
}

export function isCredentialEnvKey(key: string): boolean {
  return CREDENTIAL_ENV_KEYS.has(key) || key.endsWith('_TOKEN') || key.endsWith('_PASSWORD')
}

export function isReservedEnvKey(key: string): boolean {
  return (
    RESERVED_ENV_KEYS.has(key) || RESERVED_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  )
}
