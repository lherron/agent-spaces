/**
 * Red/green ownership for wrkq T-01015.
 *
 * Spec sources:
 * - SYSTEM_PROMPT_RESOLUTION.md, "Implementation plan" Step 3
 * - agentchat DM #2550 from animata@agent-spaces to smokey@agent-spaces
 *
 * These tests define the materialization contract before the Step 3 runtime
 * rewire exists. Keep the scenarios aligned with the wrkq red-run history so a
 * future session can confirm which fallback path was intended without
 * re-reading the surrounding coordination thread.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunMode, ScaffoldPacket } from 'spaces-config'

describe('materializeSystemPrompt Step 3', () => {
  let tempRoot: string
  let agentRoot: string
  let agentsRoot: string
  let aspHome: string
  let projectRoot: string
  let outputRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(process.cwd(), '.tmp-system-prompt-materialize-'))
    agentRoot = join(tempRoot, 'agent')
    agentsRoot = join(tempRoot, 'agents')
    aspHome = join(tempRoot, 'asp-home')
    projectRoot = join(tempRoot, 'project')
    outputRoot = join(tempRoot, 'out')

    await mkdir(agentRoot, { recursive: true })
    await mkdir(agentsRoot, { recursive: true })
    await mkdir(aspHome, { recursive: true })
    await mkdir(projectRoot, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('exports materializeSystemPromptV2 from the runtime package surface', async () => {
    const runtimeModule = (await import('./index.js')) as Record<string, unknown>

    expect(typeof runtimeModule.materializeSystemPromptV2).toBe('function')
  })

  test('prefers agent-profile instructions.template over agentsRoot and built-in fallbacks', async () => {
    await writeAgentProfile(`
schemaVersion = 2

[instructions]
template = "agent-template.toml"
`)
    await writeFile(join(agentRoot, 'agent-template.toml'), replaceTemplate('agent override'))
    await writeFile(join(agentsRoot, 'system-prompt-template.toml'), replaceTemplate('agents root'))

    const result = await materializeSystemPromptV2(outputRoot, {
      agentRoot,
      agentsRoot,
      aspHome,
      projectRoot,
      runMode: 'task',
    })

    expect(result).toEqual({
      path: join(outputRoot, 'system-prompt.md'),
      content: 'agent override',
      mode: 'replace',
    })
    expect(readPromptFile(result?.path)).toBe('agent override')
  })

  test('falls back to the agentsRoot template when no agent-specific template is configured', async () => {
    await writeFile(join(agentsRoot, 'system-prompt-template.toml'), replaceTemplate('agents root'))

    const result = await materializeSystemPromptV2(outputRoot, {
      agentRoot,
      agentsRoot,
      aspHome,
      projectRoot,
      runMode: 'task',
    })

    expect(result).toEqual({
      path: join(outputRoot, 'system-prompt.md'),
      content: 'agents root',
      mode: 'replace',
    })
  })

  test('falls back to ASP_HOME/system-prompt-template.toml when agent-specific and agentsRoot templates are absent', async () => {
    await writeFile(join(aspHome, 'system-prompt-template.toml'), replaceTemplate('asp home'))

    const result = await materializeSystemPromptV2(outputRoot, {
      agentRoot,
      agentsRoot,
      aspHome,
      projectRoot,
      runMode: 'task',
    })

    expect(result).toEqual({
      path: join(outputRoot, 'system-prompt.md'),
      content: 'asp home',
      mode: 'replace',
    })
  })

  test('built-in default fallback reproduces the legacy system prompt assembly and preserves the legacy return type', async () => {
    await writeFile(join(agentRoot, 'SOUL.md'), 'Soul')
    await writeAgentProfile(`
schemaVersion = 2

[instructions]
additionalBase = ["agent-root:///base.md"]

[instructions.byMode]
heartbeat = ["agent-root:///by-mode.md"]
`)
    await writeFile(join(agentRoot, 'base.md'), 'Base')
    await writeFile(join(agentRoot, 'HEARTBEAT.md'), 'Heartbeat')
    await writeFile(
      join(agentRoot, 'by-mode.md'),
      'By mode should not appear in the built-in default'
    )

    const scaffoldPackets: ScaffoldPacket[] = [
      { slot: 'scaffold', content: 'Scaffold inline' },
      { slot: 'scaffold', ref: 'agent-root:///scaffold.md' },
    ]
    await writeFile(join(agentRoot, 'scaffold.md'), 'Scaffold ref')

    const legacyPath = await materializeSystemPrompt(outputRoot, {
      agentRoot,
      agentsRoot,
      aspHome,
      projectRoot,
      runMode: 'heartbeat',
      scaffoldPackets,
    })
    const result = await materializeSystemPromptV2(outputRoot, {
      agentRoot,
      agentsRoot,
      aspHome,
      projectRoot,
      runMode: 'heartbeat',
      scaffoldPackets,
    })

    const expectedContent = ['Soul', 'Base', 'Heartbeat', 'Scaffold inline', 'Scaffold ref'].join(
      '\n\n---\n\n'
    )

    expect(legacyPath).toBe(join(outputRoot, 'system-prompt.md'))
    expect(result).toEqual({
      path: join(outputRoot, 'system-prompt.md'),
      content: expectedContent,
      mode: 'replace',
    })
    expect(readPromptFile(legacyPath)).toBe(expectedContent)
    expect(result?.content).not.toContain('By mode should not appear')
  })

  test('returns undefined when the built-in default fallback cannot find SOUL.md', async () => {
    const legacyPath = await materializeSystemPrompt(outputRoot, {
      agentRoot,
      agentsRoot,
      aspHome,
      projectRoot,
      runMode: 'task',
    })
    const result = await materializeSystemPromptV2(outputRoot, {
      agentRoot,
      agentsRoot,
      aspHome,
      projectRoot,
      runMode: 'task',
    })

    expect(legacyPath).toBeUndefined()
    expect(result).toBeUndefined()
    expect(existsSync(join(outputRoot, 'system-prompt.md'))).toBe(false)
  })

  test('propagates append mode from a resolved template and writes the content to disk', async () => {
    await writeAgentProfile(`
schemaVersion = 2

[instructions]
template = "append-template.toml"
`)
    await writeFile(
      join(agentRoot, 'append-template.toml'),
      `
schema_version = 1
mode = "append"

[[section]]
name = "notice"
type = "inline"
content = "append me"
`
    )

    const result = await materializeSystemPromptV2(outputRoot, {
      agentRoot,
      agentsRoot,
      aspHome,
      projectRoot,
      runMode: 'task',
    })

    expect(result).toEqual({
      path: join(outputRoot, 'system-prompt.md'),
      content: 'append me',
      mode: 'append',
    })
    expect(readPromptFile(result?.path)).toBe('append me')
  })

  async function writeAgentProfile(content: string) {
    await writeFile(join(agentRoot, 'agent-profile.toml'), content.trimStart())
  }

  function replaceTemplate(content: string): string {
    return `
schema_version = 1
mode = "replace"

[[section]]
name = "notice"
type = "inline"
content = "${content}"
`.trimStart()
  }

  function readPromptFile(path: string | undefined): string | undefined {
    if (!path) return undefined
    return readFileSync(path, 'utf8')
  }
})

type MaterializeSystemPromptFn = (
  outputPath: string,
  input: MaterializeSystemPromptTestInput
) => Promise<string | undefined>

type MaterializeSystemPromptV2Fn = (
  outputPath: string,
  input: MaterializeSystemPromptTestInput
) => Promise<MaterializedSystemPrompt | undefined>

interface MaterializeSystemPromptTestInput {
  agentRoot: string
  agentsRoot?: string | undefined
  aspHome?: string | undefined
  projectRoot?: string | undefined
  runMode: RunMode
  scaffoldPackets?: ScaffoldPacket[] | undefined
}

interface MaterializedSystemPrompt {
  path: string
  content: string
  mode: 'replace' | 'append'
}

async function materializeSystemPrompt(
  outputPath: string,
  input: MaterializeSystemPromptTestInput
) {
  const module = (await import('./system-prompt.js')) as {
    materializeSystemPrompt?: MaterializeSystemPromptFn
  }

  expect(typeof module.materializeSystemPrompt).toBe('function')
  return module.materializeSystemPrompt!(outputPath, input)
}

async function materializeSystemPromptV2(
  outputPath: string,
  input: MaterializeSystemPromptTestInput
) {
  const module = (await import('./system-prompt.js')) as {
    materializeSystemPromptV2?: MaterializeSystemPromptV2Fn
  }

  expect(typeof module.materializeSystemPromptV2).toBe('function')
  return module.materializeSystemPromptV2!(outputPath, input)
}
