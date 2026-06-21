import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

      const codexHome = response.spec.env['CODEX_HOME']
      expect(codexHome).toBe(join(fixture.aspHome, 'codex-homes', 'agent-spaces_cody'))
      const agents = readFileSync(join(codexHome as string, 'AGENTS.md'), 'utf8')
      expect(agents).not.toContain('prompt-test')
      expect(agents).not.toContain('You are cody in agent-spaces working on prompt-test')
    } finally {
      fixture.cleanup()
    }
  })

  test('task changes reuse the same semantic Codex home but different launch overlays', async () => {
    const fixture = createFixture()
    try {
      process.env['ASP_CODEX_PATH'] = createCodexShim(fixture.aspHome)
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

      const { createAgentSpacesClient } = await import('../index.js')
      const client = createAgentSpacesClient({ aspHome: fixture.aspHome })

      async function build(taskId: string) {
        return client.buildProcessInvocationSpec({
          placement: {
            agentRoot: fixture.agentRoot,
            projectRoot: fixture.projectRoot,
            cwd: fixture.projectRoot,
            runMode: 'task',
            bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
            correlation: {
              sessionRef: {
                scopeRef: `agent:cody:project:agent-spaces:task:${taskId}`,
                laneRef: 'main',
              },
            },
          },
          provider: 'openai',
          frontend: 'codex-cli',
          interactionMode: 'interactive',
          ioMode: 'pty',
        } as any)
      }

      const first = await build('task-one')
      const second = await build('task-two')

      expect(first.spec.env['CODEX_HOME']).toBe(second.spec.env['CODEX_HOME'])
      expect(first.spec.env['CODEX_HOME']).toBe(
        join(fixture.aspHome, 'codex-homes', 'agent-spaces_cody')
      )
      expect(first.spec.argv).toContain(
        'You are cody in agent-spaces working on task-one. cody code rules the world.'
      )
      expect(second.spec.argv).toContain(
        'You are cody in agent-spaces working on task-two. cody code rules the world.'
      )

      const agents = readFileSync(join(first.spec.env['CODEX_HOME'] as string, 'AGENTS.md'), 'utf8')
      expect(agents).not.toContain('task-one')
      expect(agents).not.toContain('task-two')
    } finally {
      fixture.cleanup()
    }
  })

  // T-03939: the materialized system prompt must reach codex via the home
  // AGENTS.md, NOT by being concatenated ahead of the priming prompt in the
  // visible first message (the regression). Visible launch argv = priming only.
  test('codex system prompt lands in AGENTS.md, never in the visible launch message', async () => {
    const fixture = createFixture()
    try {
      process.env['ASP_CODEX_PATH'] = createCodexShim(fixture.aspHome)
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

      // A SOUL.md makes materializeSystemPrompt emit a real system prompt via the
      // built-in default template (soul section).
      writeFileSync(
        join(fixture.agentRoot, 'SOUL.md'),
        '# Cody\nSOUL-SECRET-IDENTITY: the agent soul body.\n',
        'utf8'
      )

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
              scopeRef: 'agent:cody:project:agent-spaces:task:soul-test',
              laneRef: 'main',
            },
          },
        },
        provider: 'openai',
        frontend: 'codex-cli',
        interactionMode: 'interactive',
        ioMode: 'pty',
      } as any)

      const argv = response.spec.argv.join(' ')
      // Visible launch message is the priming prompt ONLY.
      expect(response.spec.argv).toContain(
        'You are cody in agent-spaces working on soul-test. cody code rules the world.'
      )
      // The system prompt body must NOT pollute the first message.
      expect(argv).not.toContain('SOUL-SECRET-IDENTITY')

      // It reaches the model through the home AGENTS.md instead — exactly once.
      const codexHome = response.spec.env['CODEX_HOME'] as string
      const agents = readFileSync(join(codexHome, 'AGENTS.md'), 'utf8')
      expect(agents).toContain('SOUL-SECRET-IDENTITY')
      expect((agents.match(/<!-- BEGIN praesidium-context -->/g) ?? []).length).toBe(1)
      expect(agents).not.toContain('soul-test')
    } finally {
      fixture.cleanup()
    }
  })
})
