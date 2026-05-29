import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type TmuxLaunchExecPrompts = {
  /** Path to the materialized system-prompt file; content is read+framed at launch. */
  systemPromptFile?: string | undefined
  systemPromptMode?: 'append' | 'replace' | undefined
  /** Startup priming text (delivered to the harness via argv; framed here for visibility). */
  initialPrompt?: string | undefined
}

export type TmuxLaunchExecArtifact = {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined> | undefined
  /**
   * Launch-header material. When present, the runner frame-prints the system
   * prompt + priming + key env into the pane BEFORE spawning the harness, so the
   * operator sees the same framed launch context the legacy hrc launch printed.
   */
  prompts?: TmuxLaunchExecPrompts | undefined
}

export type TmuxLaunchExecFiles = {
  launchFilePath: string
  /** Absolute path to the real launch-runner module the command line invokes. */
  runnerPath: string
  commandLine: string
}

/**
 * Resolve the absolute path to the real launch-runner module that ships beside
 * this file (`tmux-launch-runner.ts` in dev, `.js` once built by tsc). The
 * launch command invokes the runner directly — no generated script — so the
 * runner stays normal, lintable, testable code.
 */
function resolveRunnerPath(): string {
  const self = fileURLToPath(import.meta.url)
  return join(dirname(self), `tmux-launch-runner${extname(self)}`)
}

/**
 * Write the launch artifact (pure JSON data) for a tmux broker route and return
 * the command line that runs the real launch runner against it. The runner reads
 * the artifact, frame-prints the launch header, and spawns the harness.
 */
export async function writeTmuxLaunchExecFiles(
  basePath: string,
  artifact: TmuxLaunchExecArtifact
): Promise<TmuxLaunchExecFiles> {
  const launchFilePath = `${basePath}.launch.json`
  await mkdir(dirname(basePath), { recursive: true })
  await writeFile(launchFilePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  const runnerPath = resolveRunnerPath()
  return {
    launchFilePath,
    runnerPath,
    commandLine: `exec bun ${shellQuote(runnerPath)} --launch-file ${shellQuote(launchFilePath)}`,
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}
