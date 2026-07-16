import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface HookCommand {
  name: string
  run: string
  useStdin: boolean
}

interface HookExecution {
  name: string
  exitCode: number
  output: string
  invocations: string[]
}

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const zeroSha = '0'.repeat(40)
const localSha = 'a'.repeat(40)
const remoteSha = 'b'.repeat(40)
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true }))
  )
})

async function prePushCommands(): Promise<HookCommand[]> {
  const lines = (await readFile(join(repoRoot, 'lefthook.yml'), 'utf8')).split('\n')
  const prePushIndex = lines.findIndex((line) => line === 'pre-push:')
  expect(prePushIndex, 'lefthook.yml must define pre-push').toBeGreaterThanOrEqual(0)
  const nextHookIndex = lines.findIndex(
    (line, index) => index > prePushIndex && /^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(line)
  )
  const prePushEnd = nextHookIndex === -1 ? lines.length : nextHookIndex
  const commands: HookCommand[] = []

  for (let index = prePushIndex + 1; index < prePushEnd; index += 1) {
    const commandMatch = /^ {4}([A-Za-z0-9_-]+):\s*$/.exec(lines[index] ?? '')
    if (commandMatch?.[1] === undefined) continue

    const name = commandMatch[1]
    const commandLines: string[] = []
    index += 1
    while (index < prePushEnd && !/^ {4}[A-Za-z0-9_-]+:\s*$/.test(lines[index] ?? '')) {
      commandLines.push(lines[index] ?? '')
      index += 1
    }
    index -= 1

    const useStdin = commandLines.some((line) => /^ {6}use_stdin:\s*true\s*$/.test(line))
    const runIndex = commandLines.findIndex((line) => /^ {6}run:\s*/.test(line))
    expect(runIndex, `pre-push ${name} must define run`).toBeGreaterThanOrEqual(0)

    const runLine = commandLines[runIndex] ?? ''
    const inlineRun = /^ {6}run:\s*(.+)$/.exec(runLine)?.[1]
    const run =
      inlineRun === '|'
        ? commandLines
            .slice(runIndex + 1)
            .filter((line) => line.startsWith('        ') || line.length === 0)
            .map((line) => (line.startsWith('        ') ? line.slice(8) : line))
            .join('\n')
        : (inlineRun ?? '')

    commands.push({ name, run, useStdin })
  }

  expect(commands.length, 'pre-push must define at least one command').toBeGreaterThan(0)
  return commands
}

async function makeToolShims(): Promise<{ binDir: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-spaces-pre-push-'))
  temporaryRoots.push(root)
  const binDir = join(root, 'bin')
  const logPath = join(root, 'invocations.log')
  await mkdir(binDir, { recursive: true })

  for (const executable of ['bun', 'just']) {
    await writeFile(
      join(binDir, executable),
      `#!/usr/bin/env bash
set -u
printf '%s\\t%s\\n' "$HOOK_COMMAND" '${executable} '"$*" >> "$HOOK_INVOCATIONS"
`
    )
    await chmod(join(binDir, executable), 0o755)
  }

  return { binDir, logPath }
}

async function runPrePush(stdin: string): Promise<HookExecution[]> {
  const [commands, shims] = await Promise.all([prePushCommands(), makeToolShims()])
  const results: HookExecution[] = []

  for (const command of commands) {
    const result = Bun.spawnSync(['bash', '-c', command.run], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${shims.binDir}:${process.env['PATH'] ?? ''}`,
        HOOK_COMMAND: command.name,
        HOOK_INVOCATIONS: shims.logPath,
      },
      stdin: Buffer.from(command.useStdin ? stdin : ''),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const invocations = await readFile(shims.logPath, 'utf8')
      .then((text) =>
        text
          .trim()
          .split('\n')
          .filter((line) => line.startsWith(`${command.name}\t`))
          .map((line) => line.slice(command.name.length + 1))
      )
      .catch(() => [])
    results.push({
      name: command.name,
      exitCode: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
      invocations,
    })
  }

  return results
}

function expectEveryCommandRan(results: HookExecution[]): void {
  for (const result of results) {
    expect(result.exitCode, `${result.name}: ${result.output}`).toBe(0)
    expect(result.invocations, `${result.name} must run for this push`).not.toEqual([])
  }
}

describe('lefthook pre-push deletion boundary', () => {
  test('every command opts in to git pre-push stdin', async () => {
    const commands = await prePushCommands()

    for (const command of commands) {
      expect(command.useStdin, `pre-push ${command.name} must set use_stdin: true`).toBe(true)
    }
  })

  test('skips every command for a deletion-only push', async () => {
    const results = await runPrePush(`(delete) ${zeroSha} refs/heads/obsolete ${remoteSha}\n`)

    for (const result of results) {
      expect(result.exitCode, `${result.name}: ${result.output}`).toBe(0)
      expect(result.invocations, `${result.name} must skip deletion-only pushes`).toEqual([])
    }
  })

  test('runs every command for a new branch whose remote sha is all zeros', async () => {
    const results = await runPrePush(`refs/heads/new ${localSha} refs/heads/new ${zeroSha}\n`)

    expectEveryCommandRan(results)
  })

  test('runs every command for mixed deletion and normal ref updates', async () => {
    const results = await runPrePush(
      [
        `(delete) ${zeroSha} refs/heads/obsolete ${remoteSha}`,
        `refs/heads/main ${localSha} refs/heads/main ${remoteSha}`,
        '',
      ].join('\n')
    )

    expectEveryCommandRan(results)
  })

  test('runs every command when pre-push stdin is empty', async () => {
    const results = await runPrePush('')

    expectEveryCommandRan(results)
  })

  test('runs every command for a normal code push', async () => {
    const results = await runPrePush(`refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`)

    expectEveryCommandRan(results)
  })
})
