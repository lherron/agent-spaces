import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimePlacement } from 'spaces-config'

import { createAgentSpacesClient } from '../index.js'
import type { BuildHarnessBrokerInvocationRequest } from '../types.js'

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

function createFixture(options: { primingPrompt?: string | undefined } = {}): {
  agentRoot: string
  projectRoot: string
  aspHome: string
  imagePath: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-broker-priming-'))
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
${options.primingPrompt !== undefined ? `priming_prompt = "${options.primingPrompt}"\n` : ''}
[spaces]
base = []

[brain]
enabled = false
`,
    'utf8'
  )
  createCodexShim(aspHome)
  return {
    agentRoot,
    projectRoot,
    aspHome,
    imagePath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function placement(fixture: { agentRoot: string; projectRoot: string }): RuntimePlacement {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01563',
        laneRef: 'repair',
      },
      hostSessionId: 'host-01563',
    },
  }
}

async function build(
  fixture: ReturnType<typeof createFixture>,
  override: Partial<BuildHarnessBrokerInvocationRequest>
) {
  process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  return createAgentSpacesClient({ aspHome: fixture.aspHome }).buildHarnessBrokerInvocation({
    placement: placement(fixture),
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    ...override,
  })
}

function textContent(response: Awaited<ReturnType<typeof build>>): string | undefined {
  const item = response.initialInput?.content.find((content) => content.type === 'text')
  return item?.type === 'text' ? item.text : undefined
}

describe('broker priming prompt composition', () => {
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

  test('uses expanded priming when caller prompt is undefined', async () => {
    const fixture = createFixture({
      primingPrompt: 'Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}.',
    })
    try {
      const response = await build(fixture, {})

      expect(textContent(response)).toBe('Agent cody handles agent-spaces task T-01563 on repair.')
    } finally {
      fixture.cleanup()
    }
  })

  test('suppresses text input when caller prompt is empty string', async () => {
    const fixture = createFixture({
      primingPrompt: 'Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}.',
    })
    try {
      const response = await build(fixture, { prompt: '' })

      expect(response.initialInput).toBeUndefined()
    } finally {
      fixture.cleanup()
    }
  })

  test('combines expanded priming and expanded caller prompt', async () => {
    const fixture = createFixture({
      primingPrompt: 'Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}.',
    })
    try {
      const response = await build(fixture, {
        prompt: 'Inspect {{projectId}} as {{agentId}} for {{taskId}} on {{lane}}.',
      })

      expect(textContent(response)).toBe(
        [
          'Agent cody handles agent-spaces task T-01563 on repair.',
          'Inspect agent-spaces as cody for T-01563 on repair.',
        ].join('\n\n')
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('uses expanded caller prompt without a leading gap when priming is absent', async () => {
    const fixture = createFixture()
    try {
      const response = await build(fixture, {
        prompt: 'Inspect {{projectId}} as {{agentId}} for {{taskId}} on {{lane}}.',
      })

      expect(textContent(response)).toBe('Inspect agent-spaces as cody for T-01563 on repair.')
    } finally {
      fixture.cleanup()
    }
  })

  test('keeps image-only input when priming is absent', async () => {
    const fixture = createFixture()
    try {
      const response = await build(fixture, {
        attachments: [{ kind: 'file', path: fixture.imagePath, contentType: 'image/png' }],
      })

      expect(response.initialInput?.content).toEqual([
        { type: 'local_image', path: fixture.imagePath },
      ])
    } finally {
      fixture.cleanup()
    }
  })
})
