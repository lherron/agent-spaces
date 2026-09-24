/**
 * Characterization snapshots for T-04601: preparePlacementCliRuntime exposes
 * pathPrepend and folds adapter/agentchat env into lockedEnv.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { RuntimePlacement } from 'spaces-config'
import { preparePlacementCliRuntime } from '../../compiler/agent-spaces/src/prepare-cli-runtime.js'
import { compilerRuntime } from './compiler-runtime.js'

type Fixture = {
  agentRoot: string
  projectRoot: string
  aspHome: string
  codexShim: string
  toolsBin: string
  cleanup: () => void
}

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

function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'asp-env-turn-snapshot-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const toolsBin = join(agentRoot, 'tools', 'bin')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  mkdirSync(toolsBin, { recursive: true })

  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `version = 4
priming = "Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}."

[spaces]
base = []

[provisioning.codex]
model = "gpt-5.3-codex"
model_reasoning_effort = "medium"
approval_policy = "on-failure"
sandbox_mode = "workspace-write"
`,
    'utf8'
  )

  const toolPath = join(toolsBin, 'snapshot-tool')
  writeFileSync(toolPath, 'echo snapshot\n', 'utf8')
  chmodSync(toolPath, 0o755)

  const codexShim = join(aspHome, 'codex')
  writeFileSync(
    codexShim,
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
  chmodSync(codexShim, 0o755)

  return {
    agentRoot,
    projectRoot,
    aspHome,
    codexShim,
    toolsBin,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function createPlacement(fixture: Fixture, dryRun: boolean): RuntimePlacement {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task',
    dryRun,
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04601',
        laneRef: 'snapshots',
      },
      hostSessionId: 'host-session-04601',
      generation: 7,
    },
  }
}

function pickEnv(env: Record<string, string>): Record<string, string | undefined> {
  return {
    ADAPTER_CODEX_HOME: env['CODEX_HOME'],
    AGENTCHAT_ID: env['AGENTCHAT_ID'],
    AGENT_GENERATION: env['AGENT_GENERATION'],
    AGENT_HOST_SESSION_ID: env['AGENT_HOST_SESSION_ID'],
    AGENT_LANE_REF: env['AGENT_LANE_REF'],
    AGENT_SCOPE_REF: env['AGENT_SCOPE_REF'],
    HRC_GENERATION: env['HRC_GENERATION'],
    ASP_AGENT_CACHE_DIR: env['ASP_AGENT_CACHE_DIR'],
    ASP_AGENT_LOG_DIR: env['ASP_AGENT_LOG_DIR'],
    ASP_AGENT_NAME: env['ASP_AGENT_NAME'],
    ASP_AGENT_ROOT: env['ASP_AGENT_ROOT'],
    ASP_AGENT_STATE_DIR: env['ASP_AGENT_STATE_DIR'],
    ASP_AGENT_TOOLS_BIN: env['ASP_AGENT_TOOLS_BIN'],
    ASP_AGENT_TOOLS_DIR: env['ASP_AGENT_TOOLS_DIR'],
    ASP_AGENT_VAR_DIR: env['ASP_AGENT_VAR_DIR'],
    ASP_HOME: env['ASP_HOME'],
    ASP_PROJECT: env['ASP_PROJECT'],
    ASP_PROJECT_ID: env['ASP_PROJECT_ID'],
    ASP_PROJECT_ROOT: env['ASP_PROJECT_ROOT'],
    ASP_PROJECT_STATE_DIR: env['ASP_PROJECT_STATE_DIR'],
    LOCKED_ONLY: env['LOCKED_ONLY'],
    PATH: env['PATH'],
    REQ_ENV: env['REQ_ENV'],
    REQ_WINS: env['REQ_WINS'],
  }
}

describe('T-04601 env-compose snapshots', () => {
  test('preparePlacementCliRuntime folds adapterEnv and agentchatEnv into lockedEnv and emits pathPrepend', async () => {
    const fixture = createFixture()
    try {
      process.env['ASP_CODEX_PATH'] = fixture.codexShim
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

      const prepared = await preparePlacementCliRuntime(
        {
          placement: createPlacement(fixture, true),
          provider: 'openai',
          frontend: 'codex-cli',
          interactionMode: 'headless',
          model: 'gpt-5.3-codex',
          aspHome: fixture.aspHome,
          lockedEnv: { LOCKED_ONLY: 'locked-env', REQ_WINS: 'locked-env' },
          dispatchEnv: { DISPATCH_ONLY: 'dispatch-env' },
        },
        fixture.aspHome,
        undefined,
        compilerRuntime
      )

      expect(pickEnv(prepared.lockedEnv)).toEqual({
        ADAPTER_CODEX_HOME: join(fixture.aspHome, 'codex-homes', 'agent-spaces_cody'),
        AGENTCHAT_ID: 'cody',
        AGENT_GENERATION: undefined,
        AGENT_HOST_SESSION_ID: undefined,
        AGENT_LANE_REF: undefined,
        AGENT_SCOPE_REF: undefined,
        HRC_GENERATION: undefined,
        ASP_AGENT_CACHE_DIR: join(fixture.agentRoot, 'var', 'cache'),
        ASP_AGENT_LOG_DIR: join(fixture.agentRoot, 'var', 'logs'),
        ASP_AGENT_NAME: 'cody',
        ASP_AGENT_ROOT: fixture.agentRoot,
        ASP_AGENT_STATE_DIR: join(fixture.agentRoot, 'var', 'state'),
        ASP_AGENT_TOOLS_BIN: fixture.toolsBin,
        ASP_AGENT_TOOLS_DIR: join(fixture.agentRoot, 'tools'),
        ASP_AGENT_VAR_DIR: join(fixture.agentRoot, 'var'),
        ASP_HOME: fixture.aspHome,
        ASP_PROJECT: basename(fixture.projectRoot),
        ASP_PROJECT_ID: 'agent-spaces_cody',
        ASP_PROJECT_ROOT: fixture.projectRoot,
        ASP_PROJECT_STATE_DIR: join(
          fixture.agentRoot,
          'var',
          'state',
          'projects',
          'agent-spaces_cody'
        ),
        LOCKED_ONLY: 'locked-env',
        PATH: undefined,
        REQ_ENV: undefined,
        REQ_WINS: 'locked-env',
      })
      expect(prepared.dispatchEnv).toEqual({
        AGENT_ACTOR: 'cody',
        AGENT_GENERATION: '7',
        AGENT_HOST_SESSION_ID: 'host-session-04601',
        AGENT_ID: 'cody',
        AGENT_LANE: 'snapshots',
        AGENT_LANE_REF: 'snapshots',
        AGENT_PROJECT: 'agent-spaces',
        AGENT_PROJECT_ROOT: fixture.projectRoot,
        AGENT_SCOPE_REF: 'agent:cody:project:agent-spaces:task:T-04601',
        AGENT_SESSION_REF: 'agent:cody:project:agent-spaces:task:T-04601/lane:snapshots',
        AGENT_TASK: 'T-04601',
        DISPATCH_ONLY: 'dispatch-env',
        HRC_HOST_SESSION_ID: 'host-session-04601',
        HRC_GENERATION: '7',
        HRC_SESSION_REF: 'agent:cody:project:agent-spaces:task:T-04601/lane:snapshots',
        WRKQ_PRINCIPAL_REF: 'agent:cody',
      })
      expect(pickEnv(prepared.env)).toEqual({
        ...pickEnv(prepared.lockedEnv),
        AGENT_HOST_SESSION_ID: 'host-session-04601',
        AGENT_GENERATION: '7',
        AGENT_LANE_REF: 'snapshots',
        AGENT_SCOPE_REF: 'agent:cody:project:agent-spaces:task:T-04601',
        HRC_GENERATION: '7',
        PATH: expect.stringContaining(fixture.toolsBin) as unknown as string,
      })
      expect(prepared.pathPrepend).toEqual([fixture.toolsBin])
      expect(prepared.warnings).toEqual([
        'Agent tool "snapshot-tool" is executable text but has no shebang',
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test('preparePlacementCliRuntime keeps project env stable from placement scope in drain-depth worktrees', async () => {
    const fixture = createFixture()
    const worktreeProjectRoot = join(
      fixture.projectRoot,
      '..',
      'agent-spaces-T-05831-worktree-enablement'
    )
    mkdirSync(worktreeProjectRoot, { recursive: true })
    try {
      process.env['ASP_CODEX_PATH'] = fixture.codexShim
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

      const placement: RuntimePlacement = {
        ...createPlacement(fixture, true),
        projectRoot: worktreeProjectRoot,
        cwd: worktreeProjectRoot,
        bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: worktreeProjectRoot },
      }

      const prepared = await preparePlacementCliRuntime(
        {
          placement,
          provider: 'openai',
          frontend: 'codex-cli',
          interactionMode: 'headless',
          model: 'gpt-5.3-codex',
          aspHome: fixture.aspHome,
        },
        fixture.aspHome,
        undefined,
        compilerRuntime
      )

      // T-05831: drain worktrees are named for the task, not the project. The
      // runtime identity must follow the explicit placement scope so tests and
      // tools do not drift to the worktree directory basename.
      expect(prepared.lockedEnv['ASP_PROJECT']).toBe('agent-spaces')
      expect(prepared.env['ASP_PROJECT']).toBe('agent-spaces')
      expect(prepared.lockedEnv['ASP_PROJECT']).not.toBe('agent-spaces-T-05831-worktree-enablement')
      expect(prepared.dispatchEnv['AGENT_PROJECT']).toBe('agent-spaces')
      expect(prepared.lockedEnv['ASP_PROJECT_ROOT']).toBe(worktreeProjectRoot)
    } finally {
      fixture.cleanup()
    }
  })
})
