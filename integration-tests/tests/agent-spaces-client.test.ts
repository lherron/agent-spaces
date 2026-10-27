/**
 * Integration tests for `asp describe`.
 *
 * WHY: `asp describe` is the shipped surface over the agent-spaces client's
 * describe(): it materializes each target and reports its hooks, skills, tools
 * and lint warnings. Driving the real CLI against the git-backed sample
 * registry proves the report reflects what the composed spaces actually ship.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as path from 'node:path'

import {
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  getTestEnv,
  initSampleRegistry,
} from './setup.js'

const CLI_PATH = path.join(import.meta.dir, '..', '..', 'apps', 'cli', 'bin', 'asp.js')

let aspHome: string
let projectDir: string

beforeAll(async () => {
  await initSampleRegistry()
})

beforeEach(async () => {
  aspHome = await createTempAspHome()
  projectDir = await createTempProject({
    collide: { compose: ['space:cmd-collision-a@stable', 'space:cmd-collision-b@stable'] },
    hooked: { compose: ['space:hooks-bad-path@stable'] },
    mcp: { compose: ['space:mcp-server-a@stable'] },
  })
})

afterEach(async () => {
  await cleanupTempAspHome(aspHome)
  await cleanupTempProject(projectDir)
})

async function runCli(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      'bun',
      CLI_PATH,
      ...args,
      '--harness',
      'claude',
      '--project',
      projectDir,
      '--registry',
      SAMPLE_REGISTRY_DIR,
      '--asp-home',
      aspHome,
    ],
    { cwd: projectDir, env: getTestEnv(aspHome), stdout: 'pipe', stderr: 'pipe' }
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe('asp describe', () => {
  test('--json reports each installed target hooks, MCP tools and lint warnings, flagging a command collision as W201', async () => {
    const installed = await runCli(['install'])
    expect(installed.exitCode, installed.stderr).toBe(0)

    const { exitCode, stdout, stderr } = await runCli(['describe', '--json'])
    expect(exitCode, stderr).toBe(0)
    const { targets } = JSON.parse(stdout) as {
      targets: Record<
        string,
        {
          hooks: string[]
          skills: string[]
          tools: string[]
          lintWarnings: Array<{ code: string; details?: Record<string, unknown> }>
        }
      >
    }

    expect(Object.keys(targets).sort()).toEqual(['collide', 'hooked', 'mcp'])
    expect(targets['collide']?.lintWarnings).toContainEqual(
      expect.objectContaining({
        code: 'W201',
        details: expect.objectContaining({ command: 'build' }),
      })
    )
    expect(targets['hooked']?.hooks).toEqual(['SessionStart'])
    expect(targets['mcp']?.tools).toEqual(['server-alpha'])
    expect(targets['mcp']?.lintWarnings).toEqual([])
  }, 30_000)
})
