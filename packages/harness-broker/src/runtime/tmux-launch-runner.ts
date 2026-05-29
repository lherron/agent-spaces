#!/usr/bin/env bun
/**
 * Real launch runner for tmux broker routes. Invoked by absolute path
 * (`exec bun <this-file> --launch-file <json>`) inside the tmux pane: it reads
 * the launch artifact written by writeTmuxLaunchExecFiles, frame-prints the
 * launch header (system prompt + priming + key env) so the operator sees the
 * same context the legacy hrc launch printed, then spawns the harness with
 * stdio inherited.
 *
 * This is a normal module (not generated code): the launch wrapper used to be a
 * hard-coded JS string, which was untestable and unlintable. The generated
 * artifact is now pure JSON data; all behavior lives here.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

import type { TmuxLaunchExecArtifact, TmuxLaunchExecPrompts } from './tmux-launch-exec'

const FRAME_WIDTH = 72
/** Key env vars surfaced in the launch header, mirroring the legacy hrc display. */
const HEADER_ENV_KEYS = ['AGENTCHAT_ID', 'ASP_PROJECT', 'AGENTCHAT_TRANSPORT']

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`

/** Render one framed prompt section (mirrors execution/prompt-display.ts renderSection). */
function renderSection(title: string, content: string, colorCode: string): string[] {
  const color = (s: string): string => `\x1b[${colorCode}m${s}\x1b[0m`
  const lines: string[] = []
  const titleSegment = `─ ${title} `
  const topRule = '─'.repeat(Math.max(0, FRAME_WIDTH - titleSegment.length - 1))
  lines.push(color(`┌${titleSegment}`) + dim(topRule))
  lines.push(dim('│'))
  for (const line of content.split('\n')) {
    lines.push(dim('│  ') + line)
  }
  lines.push(dim('│'))
  const meta = ` ${content.length.toLocaleString()} chars`
  const bottomRule = '─'.repeat(Math.max(0, FRAME_WIDTH - meta.length - 1))
  lines.push(dim(`└${bottomRule}`) + dim(meta))
  return lines
}

/**
 * Frame-print the launch header to stdout. Best-effort: a missing or unreadable
 * system-prompt file must never block the launch. No-op when there is nothing
 * to frame (e.g. routes that carry no prompt material).
 */
export async function printLaunchHeader(
  prompts: TmuxLaunchExecPrompts | undefined,
  env: Record<string, string>
): Promise<void> {
  if (prompts === undefined) {
    return
  }
  const out: string[] = []

  let systemPrompt: string | undefined
  if (typeof prompts.systemPromptFile === 'string') {
    try {
      systemPrompt = await readFile(prompts.systemPromptFile, 'utf8')
    } catch {
      systemPrompt = undefined
    }
  }
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    const mode = prompts.systemPromptMode === 'append' ? 'append' : 'replace'
    out.push('')
    out.push(...renderSection(`System Prompt (${mode})`, systemPrompt, '36'))
  }

  if (typeof prompts.initialPrompt === 'string' && prompts.initialPrompt.length > 0) {
    out.push('')
    out.push(...renderSection('Priming Prompt', prompts.initialPrompt, '35'))
  }

  const envEntries = HEADER_ENV_KEYS.filter((key) => env[key]).map((key) => `  ${key}=${env[key]}`)
  if (envEntries.length > 0) {
    out.push('')
    out.push(dim('─ env ─'))
    out.push(...envEntries.map((entry) => dim(entry)))
  }

  if (out.length > 0) {
    process.stdout.write(`${out.join('\n')}\n\n`)
  }
}

function envFromArtifact(artifact: TmuxLaunchExecArtifact): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(artifact.env ?? {})) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  return env
}

/** Read the launch artifact, print the header, spawn the harness, and mirror its exit. */
export async function runTmuxLaunch(launchFilePath: string): Promise<never> {
  const artifact = JSON.parse(await readFile(launchFilePath, 'utf8')) as TmuxLaunchExecArtifact
  const argv = Array.isArray(artifact.argv) ? artifact.argv : []
  const command = argv[0]
  if (typeof command !== 'string' || command.length === 0) {
    process.stderr.write('harness-broker tmux launch: empty argv in launch artifact\n')
    process.exit(1)
  }
  const env = envFromArtifact(artifact)

  await printLaunchHeader(artifact.prompts, env)

  const child: ChildProcess = spawn(command, argv.slice(1), {
    cwd: typeof artifact.cwd === 'string' ? artifact.cwd : process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })

  return await new Promise<never>(() => {
    child.on('error', (error) => {
      process.stderr.write(
        `harness-broker tmux launch failed: ${error instanceof Error ? error.message : String(error)}\n`
      )
      process.exit(1)
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal)
      } else {
        process.exit(code ?? 0)
      }
    })
  })
}

async function main(): Promise<void> {
  const flagIndex = process.argv.indexOf('--launch-file')
  const launchFilePath = flagIndex === -1 ? undefined : process.argv[flagIndex + 1]
  if (!launchFilePath) {
    process.stderr.write('harness-broker tmux launch: missing --launch-file\n')
    process.exit(1)
  }
  await runTmuxLaunch(launchFilePath)
}

if (import.meta.main) {
  await main()
}
