import { resolve } from 'node:path'

import type { PraesidiumBuild } from './provenance'

/** agent-spaces checkout root; package dirs below are relative to it. */
export const REPO_ROOT = resolve(import.meta.dir, '../../..')

export const PUBLIC_CLI_PACKAGE = 'apps/cli'

export const DEV_PUBLISH_PACKAGES = [
  'contracts/agent-scope',
  'apps/cli-kit',
  'core/config',
  'core/runtime',
  'drivers/execution',
  'contracts/harness-broker-protocol',
  'contracts/harness-broker-client',
  'contracts/hrc-join-client',
  'harness/harness-broker',
  'harness/harness-broker-pi-sdk',
  'harness/agent-harness-runtime',
  'harness/agent-harness',
  'contracts/spaces-runtime-contracts',
  'contracts/aspc-protocol',
  'drivers/harness-claude',
  'drivers/harness-codex',
  'drivers/harness-muse',
  'drivers/harness-pi',
  'drivers/harness-pi-sdk',
  'compiler/agent-spaces',
  'harness/aspc',
  'harness/aspc-facade',
] as const

export const RELEASE_PUBLISH_PACKAGES = [
  ...DEV_PUBLISH_PACKAGES,
  // Keep the public CLI last: its prepack bundles the already-built workspace
  // packages into the installable @lherron/agent-spaces artifact.
  PUBLIC_CLI_PACKAGE,
] as const

/** The package.json fields the publisher reads or rewrites. */
export type PackageManifest = {
  name?: string
  version?: string
  private?: boolean
  main?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  praesidiumBuild?: PraesidiumBuild
}

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const
