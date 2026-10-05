import { dirname } from 'node:path'
import {
  type TmuxHelperLauncher,
  tmuxHelperRunner,
  writeTmuxLaunchExecFiles,
} from '../../runtime/tmux-launch-exec'
import type { ChildProcessInvocationSpec, DriverContext } from '../driver'
import { shellQuote } from '../tmux-shared'

/**
 * Live hook generation stamped into the launch env (HARNESS_BROKER_HOOK_GENERATION)
 * and used to fence out-of-band hook envelopes. A durable broker restart would
 * bump this; envelopes carrying a stale generation are rejected (T-01794 Phase D).
 * Hook-protocol fence version, NOT the HRC session generation (that is HRC_GENERATION).
 */
export const CLAUDE_HOOK_GENERATION = 1

/** Claude Code hook events the broker overlay subscribes to. */
const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'MessageDisplay',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'SubagentStop',
  'SessionEnd',
] as const

const DEFAULT_HOOK_BRIDGE_COMMAND = 'harness-broker claude-hook'

/**
 * Build the Claude Code `--settings` overlay (H1). Env vars alone do NOT make
 * Claude invoke hooks; the runtime needs an actual `hooks` settings block whose
 * commands POST each hook payload to the broker callback socket. The bridge
 * command reads the hook JSON on stdin and the `HARNESS_BROKER_*` env to build
 * the envelope, then writes it to the callback socket (broker-owned, H3).
 */
export function buildClaudeHookSettingsOverlay(options: {
  callbackSocket: string
  bridgeCommand?: string | undefined
}): { hooks: Record<string, unknown> } {
  const bridge = options.bridgeCommand ?? DEFAULT_HOOK_BRIDGE_COMMAND
  const command = `${bridge} --socket ${shellQuote(options.callbackSocket)}`
  const legacyCommandMarker = `${bridge} --socket ${options.callbackSocket}`
  const decisionCommand = `${toDecisionBridgeCommand(bridge)} --socket ${shellQuote(
    options.callbackSocket
  )} --legacy-command ${shellQuote(legacyCommandMarker)}`
  const matchAll = ['PreToolUse', 'PostToolUse']
  const hooks: Record<string, unknown> = {}
  for (const event of HOOK_EVENT_NAMES) {
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: 'command',
          command: event === 'Stop' || event === 'PostToolUse' ? decisionCommand : command,
        },
      ],
    }
    if (matchAll.includes(event)) {
      entry['matcher'] = '*'
    }
    hooks[event] = [entry]
  }
  return { hooks }
}

function toDecisionBridgeCommand(bridgeCommand: string): string {
  return bridgeCommand.replace(/\bclaude-hook\b/, 'claude-hook-decision')
}

export async function buildClaudeLaunchCommandLine(
  spec: ChildProcessInvocationSpec,
  ctx: DriverContext,
  hookEnv: {
    invocationId: string
    runtimeId?: string | undefined
    callbackSocket: string
    bridgeCommand?: string | undefined
    helperLauncher?: TmuxHelperLauncher | undefined
  }
): Promise<string> {
  const env = {
    ...spec.process.lockedEnv,
    ...(ctx.dispatchEnv ?? {}),
    HARNESS_BROKER_INVOCATION_ID: hookEnv.invocationId,
    HARNESS_BROKER_CALLBACK_SOCKET: hookEnv.callbackSocket,
    HARNESS_BROKER_HOOK_EVENTS: HOOK_EVENT_NAMES.join(','),
    HARNESS_BROKER_HOOK_GENERATION: String(CLAUDE_HOOK_GENERATION),
    ...(hookEnv.runtimeId !== undefined ? { HARNESS_BROKER_RUNTIME_ID: hookEnv.runtimeId } : {}),
  }
  const launchArgs = await buildArgsWithMergedSettings(spec.process.args, hookEnv)
  const launch = await writeTmuxLaunchExecFiles(
    `${hookEnv.callbackSocket}.claude`,
    {
      argv: [spec.process.command, ...launchArgs],
      cwd: spec.process.cwd,
      env,
      pathPrepend: spec.process.pathPrepend,
      ...(spec.launch !== undefined ? { prompts: spec.launch } : {}),
    },
    hookEnv.helperLauncher !== undefined
      ? { runner: tmuxHelperRunner(hookEnv.helperLauncher, 'tmux-launch') }
      : {}
  )
  return launch.commandLine
}

async function buildArgsWithMergedSettings(
  args: string[],
  hookEnv: { callbackSocket: string; bridgeCommand?: string | undefined }
): Promise<string[]> {
  const separatorIndex = args.indexOf('--')
  const preSeparatorArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex)
  const postSeparatorArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex)
  const durableSettingsPaths: string[] = []
  const cleanedPreSeparatorArgs: string[] = []

  for (let i = 0; i < preSeparatorArgs.length; i += 1) {
    const arg = preSeparatorArgs[i]
    if (arg === undefined) continue
    if (arg === '--settings') {
      const settingsPath = preSeparatorArgs[i + 1]
      if (settingsPath !== undefined) {
        durableSettingsPaths.push(settingsPath)
        i += 1
      }
      continue
    }
    cleanedPreSeparatorArgs.push(arg)
  }

  const mergedSettingsPath = await writeMergedSettingsFile(durableSettingsPaths, hookEnv)
  return [...cleanedPreSeparatorArgs, '--settings', mergedSettingsPath, ...postSeparatorArgs]
}

async function writeMergedSettingsFile(
  durableSettingsPaths: string[],
  hookEnv: { callbackSocket: string; bridgeCommand?: string | undefined }
): Promise<string> {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const mergedSettings: Record<string, unknown> = {}
  for (const settingsPath of durableSettingsPaths) {
    const raw = await readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    Object.assign(mergedSettings, parsed)
  }
  Object.assign(
    mergedSettings,
    buildClaudeHookSettingsOverlay({
      callbackSocket: hookEnv.callbackSocket,
      bridgeCommand: hookEnv.bridgeCommand,
    })
  )

  const settingsPath = `${hookEnv.callbackSocket}.settings.json`
  await mkdir(dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2), 'utf8')
  return settingsPath
}
