import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimePlacement } from 'spaces-config'

import { createAgentSpacesClient } from '../index.js'

function createCodexShim(dir: string): string {
  const shimPath = join(dir, 'codex')
  writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "codex 999.0.0"
  exit 0
fi
if [[ "$1" == "app-server" && "$2" == "--help" ]]; then
  echo "app-server"
  exit 0
fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(shimPath, 0o755)
  return shimPath
}

function createFixture(): {
  agentRoot: string
  projectRoot: string
  aspHome: string
  imagePath: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-process-characterization-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const imagePath = join(base, 'diagram.png')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(imagePath, 'not-really-a-png', 'utf8')

  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2
priming_prompt = "Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}."

[spaces]
base = []

[harnessDefaults.codex]
model = "gpt-5.3-codex"
model_reasoning_effort = "medium"
approval_policy = "on-failure"
sandbox_mode = "workspace-write"
profile = "workbench"
`,
    'utf8'
  )

  return {
    agentRoot,
    projectRoot,
    aspHome,
    imagePath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function createPlacement(fixture: { agentRoot: string; projectRoot: string }): RuntimePlacement {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01558',
        laneRef: 'repair',
      },
      hostSessionId: 'host-session-01558',
    },
  }
}

describe('buildProcessInvocationSpec characterization', () => {
  const originalCodexPath = process.env['ASP_CODEX_PATH']
  const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

  afterEach(() => {
    if (originalCodexPath === undefined) {
      process.env['ASP_CODEX_PATH'] = undefined
    } else {
      process.env['ASP_CODEX_PATH'] = originalCodexPath
    }
    if (originalSkipCommon === undefined) {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
    } else {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
    }
  })

  test('seals prepared Codex app-server process fields from placement', async () => {
    const fixture = createFixture()
    try {
      const codexShim = createCodexShim(fixture.aspHome)
      process.env['ASP_CODEX_PATH'] = codexShim
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

      const client = createAgentSpacesClient({ aspHome: fixture.aspHome })
      const response = await client.buildProcessInvocationSpec({
        placement: createPlacement(fixture),
        provider: 'openai',
        frontend: 'codex-cli',
        interactionMode: 'headless',
        ioMode: 'pipes',
        continuation: { provider: 'openai', key: 'thread_01558' },
        prompt: 'Inspect {{projectId}} as {{agentId}} for {{taskId}} on {{lane}}.',
        attachments: [{ kind: 'file', path: fixture.imagePath, contentType: 'image/png' }],
        lockedEnv: { EXTRA_FLAG: 'from-request', ASP_HOME: 'request-overlay-is-normalized' },
        yolo: true,
      })

      expect(response.resolvedBundle?.cwd).toBe(fixture.projectRoot)
      expect(response.spec.provider).toBe('openai')
      expect(response.spec.frontend).toBe('codex-cli')
      expect(response.spec.cwd).toBe(fixture.projectRoot)
      expect(response.spec.interactionMode).toBe('headless')
      expect(response.spec.ioMode).toBe('pipes')
      expect(response.spec.continuation).toEqual({
        provider: 'openai',
        key: 'thread_01558',
      })

      expect(response.spec.argv[0]).toBe(codexShim)
      expect(response.spec.argv.slice(1)).toEqual([
        '-c',
        'profile="workbench"',
        '--enable',
        'goals',
        'app-server',
      ])
      expect(response.spec.displayCommand).toContain(codexShim)
      expect(response.spec.displayCommand).toContain('app-server')

      expect(response.spec.env['EXTRA_FLAG']).toBe('from-request')
      expect(response.spec.env['ASP_HOME']).toBe(fixture.aspHome)
      expect(response.spec.env['AGENT_SCOPE_REF']).toBe(
        'agent:cody:project:agent-spaces:task:T-01558'
      )
      expect(response.spec.env['AGENT_LANE_REF']).toBe('repair')
      expect(response.spec.env['AGENT_HOST_SESSION_ID']).toBe('host-session-01558')
      expect(response.spec.env['ASP_PROJECT']).toBe('agent-spaces')
      expect(response.spec.env['AGENTCHAT_ID']).toBe('cody')

      expect(response.spec.codexAppServer).toEqual({
        prompt: 'Inspect agent-spaces as cody for T-01558 on repair.',
        resumeThreadId: 'thread_01558',
        model: 'gpt-5.3-codex',
        modelReasoningEffort: 'medium',
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
        profile: 'workbench',
        imageAttachments: [fixture.imagePath],
        featureFlags: ['goals'],
      })
    } finally {
      fixture.cleanup()
    }
  })
})
