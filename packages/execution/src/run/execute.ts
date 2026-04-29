import { spawn } from 'node:child_process'
import { basename, resolve } from 'node:path'

import type {
  ComposedTargetBundle,
  HarnessAdapter,
  HarnessDetection,
  HarnessRunOptions,
} from 'spaces-config'

import { displayPrompts, formatDisplayCommand } from '../prompt-display.js'
import { prepareRunOptions } from '../run-codex.js'

import type { RunInvocationResult } from './types.js'
import { formatCommand, formatEnvPrefix } from './util.js'

export interface ExecuteHarnessResult {
  exitCode: number
  invocation?: RunInvocationResult | undefined
  command: string
  displayCommand: string
  systemPrompt?: string | undefined
  systemPromptMode?: 'replace' | 'append' | undefined
}

export interface MaterializedPromptResult {
  content: string
  mode: 'replace' | 'append'
  reminderContent?: string | undefined
  maxChars?: number | undefined
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
  }
): Promise<ExecuteHarnessResult> {
  const preparedRunOptions = await prepareRunOptions(adapter, bundle, runOptions)
  const args = adapter.buildRunArgs(bundle, preparedRunOptions)
  const projectEnv: Record<string, string> = {}
  const projectPath = preparedRunOptions.projectPath ?? runOptions.projectPath
  if (projectPath) {
    projectEnv['ASP_PROJECT'] = basename(resolve(projectPath))
  }
  projectEnv['AGENTCHAT_ID'] = bundle.targetName

  const harnessEnv: Record<string, string> = {
    ...projectEnv,
    ...(options.env ?? {}),
    ...adapter.getRunEnv(bundle, preparedRunOptions),
  }

  const commandPath = detection.path ?? adapter.id
  const envPrefix = formatEnvPrefix(harnessEnv)
  const command = envPrefix + formatCommand(commandPath, args)

  if (options.dryRun) {
    return {
      exitCode: 0,
      command,
      displayCommand: envPrefix + formatDisplayCommand(commandPath, args),
      systemPrompt: preparedRunOptions.systemPrompt,
      systemPromptMode: preparedRunOptions.systemPromptMode,
    }
  }

  await displayPrompts({
    systemPrompt: preparedRunOptions.systemPrompt,
    systemPromptMode: preparedRunOptions.systemPromptMode,
    reminderContent: options.reminderContent,
    primingPrompt: preparedRunOptions.prompt,
    command: envPrefix + formatDisplayCommand(commandPath, args),
    showCommand: true,
    pagePrompts: options.pagePrompts,
  })

  const { exitCode, stdout, stderr } = await executeHarnessCommand(commandPath, args, {
    interactive: preparedRunOptions.interactive,
    cwd: preparedRunOptions.cwd ?? preparedRunOptions.projectPath,
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
    displayCommand: envPrefix + formatDisplayCommand(commandPath, args),
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
