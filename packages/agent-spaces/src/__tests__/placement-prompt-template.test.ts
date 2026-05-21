import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-placement-prompt-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })

  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2
priming_prompt = "You are {{agentId}} in {{projectId}} working on {{taskId}}. {{agentId}} code rules the world."

[spaces]
base = []

[brain]
enabled = false
`,
    'utf8'
  )

  return {
    agentRoot,
    projectRoot,
    aspHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

describe('placement prompt template expansion', () => {
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

  test('buildProcessInvocationSpec expands canonical placement ScopeRef variables', async () => {
    const fixture = createFixture()
    try {
      process.env['ASP_CODEX_PATH'] = createCodexShim(fixture.aspHome)
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

      const { createAgentSpacesClient } = await import('../index.js')
      const client = createAgentSpacesClient({ aspHome: fixture.aspHome })

      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot: fixture.agentRoot,
          projectRoot: fixture.projectRoot,
          cwd: fixture.projectRoot,
          runMode: 'task',
          bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
          correlation: {
            sessionRef: {
              scopeRef: 'agent:cody:project:agent-spaces:task:prompt-test',
              laneRef: 'main',
            },
          },
        },
        provider: 'openai',
        frontend: 'codex-cli',
        interactionMode: 'interactive',
        ioMode: 'pty',
      } as any)

      expect(response.spec.argv).toContain(
        'You are cody in agent-spaces working on prompt-test. cody code rules the world.'
      )
      expect(response.spec.argv.join(' ')).not.toContain('{{agentId}}')
      expect(response.spec.argv.join(' ')).not.toContain('{{taskId}}')
    } finally {
      fixture.cleanup()
    }
  })
})
