import { describe, expect, it } from 'bun:test'

import type { BuildProcessInvocationSpecRequest } from '../types'

function makeRequest(
  frontend: BuildProcessInvocationSpecRequest['frontend']
): BuildProcessInvocationSpecRequest {
  return {
    aspHome: '/tmp/asp-home',
    spec: { spaces: [] },
    provider: 'openai',
    frontend,
    interactionMode: 'interactive',
    ioMode: 'pty',
    cwd: '/tmp/project',
  }
}

describe('BuildProcessInvocationSpecRequest frontend type', () => {
  it('accepts the public pi-cli frontend alongside existing CLI frontends', () => {
    expect(makeRequest('claude-code').frontend).toBe('claude-code')
    expect(makeRequest('codex-cli').frontend).toBe('codex-cli')
    expect(makeRequest('pi-cli').frontend).toBe('pi-cli')
  })
})
