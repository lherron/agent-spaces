import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import type {
  ComposedTargetBundle,
  HarnessAdapter,
  HarnessDetection,
  HarnessRunOptions,
} from 'spaces-config'

import { displayPrompts, formatDisplayCommand } from '../prompt-display.js'
import { prepareRunOptions } from '../run-codex.js'

import type { AgentToolRuntimeContext } from './agent-tools.js'
import { prepareAgentToolRuntime } from './agent-tools.js'
import type { LaunchShape, RunInvocationResult } from './types.js'
import { formatCommand, formatEnvPrefix } from './util.js'

export interface ExecuteHarnessResult {
  exitCode: number
  invocation?: RunInvocationResult | undefined
  command: string
  displayCommand: string
  warnings: string[]
  systemPrompt?: string | undefined
  systemPromptMode?: 'replace' | 'append' | undefined
  launch: LaunchShape
}

export interface MaterializedPromptResult {
  content: string
  mode: 'replace' | 'append'
  reminderContent?: string | undefined
  maxChars?: number | undefined
  promptSectionSizes?: string[] | undefined
  reminderSectionSizes?: string[] | undefined
  totalContextChars?: number | undefined
  nearMaxChars?: boolean | undefined
}

async function executeHarnessCommand(
  commandPath: string,
  args: string[],
  options: {
    interactive?: boolean | undefined
    cwd?: string | undefined
    env?: Record<string, string> | undefined
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const captureOutput = options.interactive === false
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        SHELL: '/bin/bash',
        ...options.env,
      },
      stdio: captureOutput ? 'pipe' : 'inherit',
    })

    if (captureOutput && child.stdin) {
      child.stdin.end()
    }

    let stdout = ''
    let stderr = ''

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
    }

    child.on('error', (err) => {
      reject(err)
    })

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

function resolveCodexAppSelectorArgs(): string[] {
  const bundleId = process.env['ASP_CODEX_APP_BUNDLE']?.trim()
  if (bundleId) {
    return ['-b', bundleId]
  }

  return ['-a', process.env['ASP_CODEX_APP_NAME']?.trim() || 'Codex']
}

async function buildCodexAppLaunch(
  launchCwd: string | undefined,
  harnessEnv: Record<string, string>,
  options: { dryRun?: boolean | undefined }
): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const codexHome = harnessEnv['CODEX_HOME']
  if (!codexHome) {
    throw new Error('Codex app launch requires CODEX_HOME from the prepared Codex runtime home')
  }

  const userDataPath =
    process.env['CODEX_ELECTRON_USER_DATA_PATH']?.trim() || join(codexHome, 'codex-app-profile')
  if (!options.dryRun) {
    await mkdir(userDataPath, { recursive: true })
  }

  const workspacePath = launchCwd ?? process.cwd()
  return {
    command: '/usr/bin/open',
    args: [
      '-n',
      ...resolveCodexAppSelectorArgs(),
      '--env',
      `CODEX_HOME=${codexHome}`,
      '--env',
      `CODEX_ELECTRON_USER_DATA_PATH=${userDataPath}`,
      workspacePath,
      '--args',
      `--user-data-dir=${userDataPath}`,
    ],
    env: {
      ...harnessEnv,
      CODEX_ELECTRON_USER_DATA_PATH: userDataPath,
    },
  }
}

export async function executeHarnessRun(
  adapter: HarnessAdapter,
  detection: HarnessDetection,
  bundle: ComposedTargetBundle,
  runOptions: HarnessRunOptions,
  options: {
    env?: Record<string, string> | undefined
    dryRun?: boolean | undefined
    reminderContent?: string | undefined
    pagePrompts?: boolean | undefined
    agentToolRuntime?: AgentToolRuntimeContext | undefined
    /**
     * Pre-compiled foreground launch shape (argv + composed env + cwd) sourced
     * from the compiler's foreground TerminalExecutionProfile. When present, the
     * launch shape is taken verbatim from the compiled plan instead of being
     * derived from the adapter (buildRunArgs/getRunEnv) and the brain/tool
     * runtimes — those already ran inside the compiler. ONE code path: this
     * function still renders the same displayPrompts sections and inherit-spawns.
     */
    compiledLaunch?: LaunchShape | undefined
  }
): Promise<ExecuteHarnessResult> {
  const compiled = options.compiledLaunch
  const preparedRunOptions = compiled
    ? runOptions
    : await prepareRunOptions(adapter, bundle, runOptions)
  const warnings: string[] = []

  let commandPath: string
  let args: string[]
  let harnessEnv: Record<string, string>
  let launchCwd: string | undefined

  if (compiled) {
    if (runOptions.launchSurface === 'codex-app') {
      throw new Error('Codex app launch cannot use a compiled terminal launch')
    }
    commandPath = compiled.command
    args = compiled.args
    harnessEnv = compiled.env
    launchCwd = compiled.cwd ?? preparedRunOptions.cwd ?? preparedRunOptions.projectPath
  } else {
    const useCodexApp = preparedRunOptions.launchSurface === 'codex-app'
    if (useCodexApp && adapter.id !== 'codex') {
      throw new Error(`Launch surface "codex-app" is only supported by the codex harness`)
    }

    args = useCodexApp ? [] : adapter.buildRunArgs(bundle, preparedRunOptions)
    const projectEnv: Record<string, string> = {}
    const projectPath = preparedRunOptions.projectPath ?? runOptions.projectPath
    if (projectPath) {
      projectEnv['ASP_PROJECT'] = basename(resolve(projectPath))
    }
    projectEnv['AGENTCHAT_ID'] = bundle.targetName

    harnessEnv = {
      ...projectEnv,
      ...(options.env ?? {}),
      ...adapter.getRunEnv(bundle, preparedRunOptions),
    }
    if (options.agentToolRuntime) {
      const toolRuntime = await prepareAgentToolRuntime(options.agentToolRuntime, harnessEnv)
      harnessEnv = { ...harnessEnv, ...toolRuntime.env }
      warnings.push(...toolRuntime.warnings)
    }
    commandPath = detection.path ?? adapter.id
    launchCwd = preparedRunOptions.cwd ?? preparedRunOptions.projectPath
    if (useCodexApp) {
      const appLaunch = await buildCodexAppLaunch(launchCwd, harnessEnv, {
        dryRun: options.dryRun,
      })
      commandPath = appLaunch.command
      args = appLaunch.args
      harnessEnv = appLaunch.env
    }
  }

  const envPrefix = formatEnvPrefix(harnessEnv)
  const command = envPrefix + formatCommand(commandPath, args)
  const displayCommand = envPrefix + formatDisplayCommand(commandPath, args)
  const launch: LaunchShape = {
    command: commandPath,
    args,
    ...(launchCwd !== undefined ? { cwd: launchCwd } : {}),
    env: harnessEnv,
  }

  if (options.dryRun) {
    return {
      exitCode: 0,
      command,
      displayCommand,
      warnings,
      systemPrompt: preparedRunOptions.systemPrompt,
      systemPromptMode: preparedRunOptions.systemPromptMode,
      launch,
    }
  }

  await displayPrompts({
    systemPrompt: preparedRunOptions.systemPrompt,
    systemPromptMode: preparedRunOptions.systemPromptMode,
    reminderContent: options.reminderContent,
    primingPrompt: preparedRunOptions.prompt,
    command: displayCommand,
    showCommand: true,
    pagePrompts: options.pagePrompts,
  })

  // The codex-app surface always captures output (non-interactive); every other
  // surface honours the prepared interactive flag. Otherwise the spawn is identical.
  const interactive =
    preparedRunOptions.launchSurface === 'codex-app' ? false : preparedRunOptions.interactive
  const { exitCode, stdout, stderr } = await executeHarnessCommand(commandPath, args, {
    interactive,
    cwd: launchCwd,
    env: harnessEnv,
  })

  if (stdout) {
    process.stdout.write(stdout)
  }
  if (stderr) {
    process.stderr.write(stderr)
  }

  return {
    exitCode,
    command,
    displayCommand,
    warnings,
    launch,
    invocation:
      preparedRunOptions.interactive === false
        ? {
            exitCode,
            stdout,
            stderr,
          }
        : undefined,
  }
}
