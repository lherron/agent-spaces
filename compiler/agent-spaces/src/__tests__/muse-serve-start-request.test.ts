import { describe, expect, test } from 'bun:test'

import { toHarnessBrokerStartRequest } from '../broker-invocation.js'
import type { PreparedPlacementCliRuntime } from '../prepare-cli-runtime.js'
import type { BuildHarnessBrokerInvocationRequest } from '../types.js'

function prepared(): PreparedPlacementCliRuntime {
  return {
    commandPath: '/usr/local/bin/muse',
    cwd: '/workspace/project',
    lockedEnv: {
      HOME: '/Users/operator',
      XDG_CONFIG_HOME: '/tmp/bundle/muse.home/.config',
      ASP_PROJECT: 'agent-spaces',
    },
    pathPrepend: [],
    imageAttachmentPaths: [],
    expandedPrompt: 'reply ok',
    resolvedBundle: undefined,
    warnings: [],
  } as unknown as PreparedPlacementCliRuntime
}

function request(): BuildHarnessBrokerInvocationRequest {
  return {
    placement: {} as BuildHarnessBrokerInvocationRequest['placement'],
    provider: 'meta',
    frontend: 'muse-cli',
    interactionMode: 'headless',
    brokerDriver: 'muse-serve',
    generation: 1,
    correlation: { test: 'muse-serve-start-request' },
  }
}

describe('toHarnessBrokerStartRequest — muse-serve headless birth (muse seat)', () => {
  test('builds a schema-valid muse-serve spec mirroring the matrix fixture', () => {
    const built = toHarnessBrokerStartRequest(prepared(), request())
    expect(built.spec.harness).toEqual({
      frontend: 'muse-cli',
      provider: 'meta',
      driver: 'muse-serve',
    })
    expect(built.spec.process.command).toBe('/usr/local/bin/muse')
    expect(built.spec.process.args).toEqual(['serve', '--trust-workspace'])
    expect(built.spec.process.harnessTransport).toEqual({ kind: 'jsonrpc-stdio' })
    const driver = built.spec.driver as { kind: string; homeMode: string }
    expect(driver.kind).toBe('muse-serve')
    expect(driver.homeMode).toBe('operator')
    // Ambient/reserved home keys cannot ride lockedEnv; the driver composes
    // HOME/XDG itself at birth.
    expect(built.spec.process.lockedEnv).toEqual({ ASP_PROJECT: 'agent-spaces' })
  })
})
