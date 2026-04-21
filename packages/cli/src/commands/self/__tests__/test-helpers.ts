import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', '..', '..', 'bin', 'asp.js')
const tempDirs: string[] = []

export interface SelfFixture {
  dir: string
  agentsRoot: string
  agentRoot: string
  bundleRoot: string
  launchFile: string
  env: Record<string, string>
}

export interface SelfFixtureOptions {
  agentName?: string | undefined
  launchArgv?: string[] | undefined
  template?: string | undefined
  profileToml?: string | undefined
  reminderContent?: string | undefined
  bundleSystemPrompt?: string | undefined
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })))
  tempDirs.length = 0
}

export async function setupSelfFixture(options: SelfFixtureOptions = {}): Promise<SelfFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'asp-self-cody-'))
  tempDirs.push(dir)

  const agentName = options.agentName ?? 'clod'
  const agentsRoot = join(dir, 'agents')
  const agentRoot = join(agentsRoot, agentName)
  const bundleRoot = join(dir, 'bundle', 'claude')
  const launchFile = join(dir, 'launch.json')

  await mkdir(join(agentRoot, 'skills'), { recursive: true })
  await mkdir(join(bundleRoot, 'plugins'), { recursive: true })

  await writeFile(join(agentRoot, 'SOUL.md'), `# ${agentName}\nAgent identity.\n`)
  await writeFile(
    join(agentRoot, 'agent-profile.toml'),
    options.profileToml ?? 'schemaVersion = 2\n[identity]\ndisplay = "Clod"\n'
  )
  await writeFile(join(agentsRoot, 'AGENT_MOTD.md'), 'shared motd\n')
  await writeFile(join(agentsRoot, 'conventions.md'), 'shared conventions\n')

  if (options.template) {
    await writeFile(join(agentsRoot, 'context-template.toml'), options.template)
  }

  await writeFile(join(bundleRoot, 'settings.json'), '{}')

  if (options.reminderContent !== undefined) {
    await writeFile(join(bundleRoot, 'session-reminder.md'), options.reminderContent)
  }

  if (options.bundleSystemPrompt !== undefined) {
    await writeFile(join(bundleRoot, 'system-prompt.md'), options.bundleSystemPrompt)
  }

  await writeFile(
    launchFile,
    JSON.stringify({
      launchId: 'launch-TEST',
      hostSessionId: 'hsid-TEST',
      generation: 1,
      runtimeId: 'rt-TEST',
      runId: 'run-TEST',
      harness: 'claude-code',
      provider: 'anthropic',
      argv: options.launchArgv ?? [
        'claude',
        '--append-system-prompt',
        'test-sys-prompt',
        '--',
        'test-priming',
      ],
      env: { AGENTCHAT_ID: agentName },
      cwd: dir,
      callbackSocketPath: '/tmp/sock',
      spoolDir: join(dir, 'spool'),
      correlationEnv: {},
    })
  )

  const env: Record<string, string> = {
    AGENTCHAT_ID: agentName,
    ASP_PROJECT: 'test-proj',
    ASP_HOME: dir,
    ASP_AGENTS_ROOT: agentsRoot,
    ASP_PLUGIN_ROOT: bundleRoot,
    HRC_LAUNCH_FILE: launchFile,
    ASP_PRIMING_PROMPT: 'priming-from-env',
    HRC_SESSION_REF: `agent:${agentName}:project:test-proj`,
    HRC_RUNTIME_ID: 'rt-TEST',
    HRC_RUN_ID: 'run-TEST',
    HRC_LAUNCH_ID: 'launch-TEST',
    HRC_GENERATION: '1',
    HRC_HOST_SESSION_ID: 'hsid-TEST',
  }

  return { dir, agentsRoot, agentRoot, bundleRoot, launchFile, env }
}

export function runAsp(
  args: string[],
  env: Record<string, string>
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const baseEnv = { ...process.env }
    for (const key of Object.keys(baseEnv)) {
      if (key.startsWith('HRC_') || key.startsWith('ASP_') || key === 'AGENTCHAT_ID') {
        delete baseEnv[key]
      }
    }

    const stdout = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...baseEnv, ...env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (error: unknown) {
    const processError = error as {
      stdout?: { toString(): string }
      stderr?: { toString(): string }
      status?: number
    }
    return {
      stdout: processError.stdout?.toString() ?? '',
      stderr: processError.stderr?.toString() ?? '',
      exitCode: processError.status ?? 1,
    }
  }
}
