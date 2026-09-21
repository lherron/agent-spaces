import { describe, expect, test } from 'bun:test'
import type { RuntimePlacement } from 'spaces-config'

import {
  toHarnessBrokerStartRequest,
  validateBrokerInvocationRequest,
} from '../broker-invocation.js'
import type { PreparedPlacementCliRuntime } from '../prepare-cli-runtime.js'
import type { BuildHarnessBrokerInvocationRequest } from '../types.js'

const placement = {
  agentRoot: '/tmp/agents/cody',
  projectRoot: '/tmp/projects/agent-spaces',
  cwd: '/tmp/projects/agent-spaces',
  runMode: 'task',
  bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: '/tmp/projects/agent-spaces' },
} as RuntimePlacement

function prepared(): PreparedPlacementCliRuntime {
  return {
    commandPath: '/usr/local/bin/codex',
    args: ['app-server'],
    cwd: '/tmp/projects/agent-spaces',
    lockedEnv: {},
    pathPrepend: [],
    imageAttachmentPaths: [],
    resolvedBundle: { bundleIdentity: 'resolved-payload-test' },
    warnings: [],
    runOptions: {},
  } as unknown as PreparedPlacementCliRuntime
}

function request(
  overrides: Partial<BuildHarnessBrokerInvocationRequest> = {}
): BuildHarnessBrokerInvocationRequest {
  return {
    placement,
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    brokerDriver: 'codex-app-server',
    generation: 1,
    ...overrides,
  }
}

describe('broker invocation resolved payload boundary', () => {
  test('requires a driver pre-resolved by the central harness selection catalog', () => {
    expect(() => validateBrokerInvocationRequest(request({ brokerDriver: undefined }))).toThrow(
      /already resolved by the harness selection catalog/
    )
  })

  test('does not default an unsupported selected driver to a Codex route', () => {
    expect(() =>
      toHarnessBrokerStartRequest(
        prepared(),
        request({
          provider: 'anthropic',
          frontend: 'claude-code',
          interactionMode: 'interactive',
          brokerDriver: 'claude-code-tmux',
        })
      )
    ).toThrow(/cannot materialize unsupported selected driver/)
  })

  test('validates the selected Codex payload identity before materialization', () => {
    expect(() =>
      toHarnessBrokerStartRequest(prepared(), request({ provider: 'meta', frontend: 'muse-cli' }))
    ).toThrow(/codex-cli\/openai launch identity/)
  })
})
