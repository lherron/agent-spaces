import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

interface HookCommandConfig {
  files?: string
  run: string
  stage_fixed?: boolean
  use_stdin?: boolean
}

interface HookConfig {
  min_version: string
  lefthook: string
  'pre-commit': {
    parallel: boolean
    commands: Record<string, HookCommandConfig>
  }
  'pre-push': {
    files: string
    commands: Record<string, HookCommandConfig>
  }
}

interface HookFixture {
  binDir: string
  logPath: string
  remote: string
  work: string
}

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
// Resolve by walking up rather than assuming this repo's node_modules. Under the
// praesidium dev workspace agent-spaces, hrc-runtime and agent-control-plane
// install as one workspace and bun hoists binaries to the workspace root, so the
// repo-local path exists only in a standalone install. Walking up satisfies both.
function resolveWorkspaceBinary(name: string): string {
  for (let directory = repoRoot; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', '.bin', name)
    if (existsSync(candidate)) return candidate
    if (dirname(directory) === directory) {
      throw new Error(`cannot resolve ${name} in any node_modules/.bin above ${repoRoot}`)
    }
  }
}

const lefthookBinary = resolveWorkspaceBinary('lefthook')
const scopeScript = join(repoRoot, 'scripts', 'run-if-code-changed.ts')
const scopeLibrary = join(repoRoot, 'scripts', 'lib', 'hook-change-scope.ts')
const optimizationLibrary = join(repoRoot, 'scripts', 'lib', 'hook-optimization.ts')
const timingLibrary = join(repoRoot, 'scripts', 'lib', 'hook-timing.ts')
const workspaceGraphLibrary = join(repoRoot, 'scripts', 'lib', 'workspace-graph.ts')
const codeOnlyPreCommitCommands = [
  'lint',
  'boundaries',
  'harness-boundaries',
  'manifests',
  'dependency-pins',
  'suppressions',
  'public-surface',
  'rule-authoring',
  'build',
]
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true }))
  )
})

function run(command: string[], cwd: string, env: Record<string, string | undefined> = {}): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  expect(result.exitCode, `${command.join(' ')}\n${output}`).toBe(0)
  return output
}

async function readConfig(): Promise<HookConfig> {
  return Bun.YAML.parse(await readFile(join(repoRoot, 'lefthook.yml'), 'utf8')) as HookConfig
}

async function readInvocations(logPath: string): Promise<string[]> {
  return readFile(logPath, 'utf8')
    .then((text) => text.trim().split('\n').filter(Boolean))
    .catch(() => [])
}

function hookEnvironment(fixture: HookFixture): Record<string, string> {
  return {
    HOOK_INVOCATIONS: fixture.logPath,
    PATH: `${fixture.binDir}:${process.env['PATH'] ?? ''}`,
  }
}

async function makeHookFixture(): Promise<HookFixture> {
  const root = await mkdtemp(join(tmpdir(), 'agent-spaces-lefthook-'))
  temporaryRoots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  const binDir = join(root, 'bin')
  const logPath = join(root, 'invocations.log')

  await mkdir(binDir, { recursive: true })
  await writeFile(
    join(binDir, 'hook-probe'),
    `#!/bin/sh
if [ "$1" = "paths" ]; then
  printf '%s\\n' "$ASP_HOOK_CHANGED_PATHS_JSON" >> "$HOOK_INVOCATIONS"
  exit 0
fi
printf '%s\\n' "$*" >> "$HOOK_INVOCATIONS"
`
  )
  await chmod(join(binDir, 'hook-probe'), 0o755)

  run(['git', 'init', '--bare', remote], root)
  run(['git', 'init', '-b', 'main', work], root)
  run(['git', 'config', 'user.name', 'Hook Test'], work)
  run(['git', 'config', 'user.email', 'hook-test@example.com'], work)
  run(['git', 'config', 'commit.gpgSign', 'false'], work)
  await mkdir(join(work, 'src'), { recursive: true })
  await writeFile(join(work, 'README.md'), '# baseline\n')
  await writeFile(join(work, 'src', 'app.ts'), 'export const baseline = true\n')
  run(['git', 'add', 'README.md', 'src/app.ts'], work)
  run(['git', 'commit', '-m', 'baseline'], work)
  run(['git', 'remote', 'add', 'origin', remote], work)
  run(['git', 'push', '-u', 'origin', 'main'], work)

  await mkdir(join(work, 'scripts', 'lib'), { recursive: true })
  await writeFile(join(work, 'scripts', 'run-if-code-changed.ts'), await readFile(scopeScript))
  await writeFile(
    join(work, 'scripts', 'lib', 'hook-change-scope.ts'),
    await readFile(scopeLibrary)
  )
  await writeFile(join(work, 'scripts', 'lib', 'hook-timing.ts'), await readFile(timingLibrary))
  await writeFile(
    join(work, 'scripts', 'lib', 'hook-optimization.ts'),
    await readFile(optimizationLibrary)
  )
  await writeFile(
    join(work, 'scripts', 'lib', 'workspace-graph.ts'),
    await readFile(workspaceGraphLibrary)
  )
  await writeFile(
    join(work, 'lefthook.yml'),
    `min_version: "2.1.10"
pre-commit:
  parallel: false
  commands:
    gitleaks:
      run: hook-probe gitleaks
    code:
      run: bun scripts/run-if-code-changed.ts pre-commit code -- hook-probe code
    docs:
      run: hook-probe docs
pre-push:
  parallel: false
  files: printf 'lefthook.yml\\n'
  commands:
    validation:
      use_stdin: true
      run: bun scripts/run-if-code-changed.ts pre-push validation -- sh -c 'hook-probe validation' {files}
`
  )
  run([lefthookBinary, 'install'], work)

  return { binDir, logPath, remote, work }
}

async function commit(
  fixture: HookFixture,
  message: string,
  paths: string[],
  verify = false
): Promise<string[]> {
  run(['git', 'add', '--all', '--', ...paths], fixture.work)
  await writeFile(fixture.logPath, '')
  run(
    ['git', 'commit', ...(verify ? [] : ['--no-verify']), '-m', message],
    fixture.work,
    hookEnvironment(fixture)
  )
  return readInvocations(fixture.logPath)
}

async function push(fixture: HookFixture, args: string[] = ['origin']): Promise<string[]> {
  await writeFile(fixture.logPath, '')
  run(['git', 'push', ...args], fixture.work, hookEnvironment(fixture))
  return readInvocations(fixture.logPath)
}

describe('lefthook v2 configuration', () => {
  test('pins the installed major and validates the configuration', async () => {
    const packageJson = (await Bun.file(join(repoRoot, 'package.json')).json()) as {
      devDependencies: Record<string, string>
    }
    const config = await readConfig()

    expect(packageJson.devDependencies['lefthook']).toBe('2.1.10')
    expect(config.min_version).toBe('2.1.10')
    expect(config.lefthook).toBe('bun scripts/run-lefthook-with-timing.ts')
    expect(config['pre-commit'].parallel).toBeTrue()
    run([lefthookBinary, 'validate'], repoRoot)
  })

  test('keeps secret and documentation checks unconditional', async () => {
    const commands = (await readConfig())['pre-commit'].commands

    expect(commands['gitleaks']?.run).toBe(
      'bun scripts/run-hook-command.ts pre-commit {lefthook_job_name} -- gitleaks protect --staged --redact'
    )
    expect(commands['doc-reachability']?.run).toBe(
      'bun scripts/run-hook-command.ts pre-commit {lefthook_job_name} -- bun scripts/check-doc-reachability.ts'
    )
    for (const name of codeOnlyPreCommitCommands) {
      const prefix = `bun scripts/run-if-code-changed.ts pre-commit {lefthook_job_name}${
        name === 'public-surface' ? ' --only=public-surface' : ''
      } -- `
      expect(commands[name]?.run, name).toStartWith(prefix)
    }
  })

  test('uses one fail-safe pre-push stdin consumer', async () => {
    const config = await readConfig()
    const prePush = config['pre-push']
    expect(prePush.files).toBe("printf 'lefthook.yml\\n'")
    expect(Object.keys(prePush.commands)).toEqual(['code-validation'])
    const codeValidation = prePush.commands['code-validation']
    expect(codeValidation.use_stdin).toBeTrue()
    expect(codeValidation.run).toContain('refs=$(cat)')
    expect(codeValidation.run).toContain(
      'bun scripts/run-if-code-changed.ts pre-push {lefthook_job_name} -- sh -c'
    )
    expect(codeValidation.run).toContain('bun install && bun run test:fast')
    expect(codeValidation.run.indexOf('wrkp git push "$@"')).toBeGreaterThan(
      codeValidation.run.indexOf('bun install && bun run test:fast')
    )
    expect(config['post-commit'].commands['wrkp-git-commit'].run).toBe(
      'command -v wrkp >/dev/null 2>&1 && wrkp git commit || true'
    )
  })
})

describe('lefthook v2 real pre-commit boundaries', () => {
  test('passes exact changed paths to validation and scopes public-surface work', async () => {
    const fixture = await makeHookFixture()
    await mkdir(join(fixture.work, 'scripts'), { recursive: true })
    await writeFile(join(fixture.work, 'scripts', 'probe.ts'), 'export const probe = true\n')
    run(['git', 'add', 'scripts/probe.ts'], fixture.work)

    run(
      [
        'bun',
        'scripts/run-if-code-changed.ts',
        'pre-commit',
        'selection',
        '--',
        'hook-probe',
        'paths',
      ],
      fixture.work,
      hookEnvironment(fixture)
    )
    expect(JSON.parse((await readInvocations(fixture.logPath))[0] ?? '[]')).toEqual([
      'scripts/probe.ts',
    ])

    await writeFile(fixture.logPath, '')
    const skipped = run(
      [
        'bun',
        'scripts/run-if-code-changed.ts',
        'pre-commit',
        'public-surface',
        '--only=public-surface',
        '--',
        'hook-probe',
        'public-surface',
      ],
      fixture.work,
      hookEnvironment(fixture)
    )
    expect(skipped).toContain('skipping public-surface validation for unrelated changes')
    expect(await readInvocations(fixture.logPath)).toEqual([])
  })

  test('runs only unconditional checks for documentation extensions regardless of case', async () => {
    const fixture = await makeHookFixture()
    await mkdir(join(fixture.work, 'docs'), { recursive: true })
    const files = ['README.MARKDOWN', 'docs/Reference.HTML', 'docs/notes.TxT', 'docs/legacy.HtM']
    for (const file of files) await writeFile(join(fixture.work, file), 'documentation\n')

    expect((await commit(fixture, 'documentation files', files, true)).sort()).toEqual([
      'docs',
      'gitleaks',
    ])
  })

  test('runs code checks for a code deletion', async () => {
    const fixture = await makeHookFixture()
    await rm(join(fixture.work, 'src', 'app.ts'))

    expect((await commit(fixture, 'delete code', ['src/app.ts'], true)).sort()).toEqual([
      'code',
      'docs',
      'gitleaks',
    ])
  })

  test('runs code checks for a code-to-document rename', async () => {
    const fixture = await makeHookFixture()
    await mkdir(join(fixture.work, 'docs'), { recursive: true })
    await rename(join(fixture.work, 'src', 'app.ts'), join(fixture.work, 'docs', 'app.md'))

    expect(
      (await commit(fixture, 'rename code to docs', ['src/app.ts', 'docs/app.md'], true)).sort()
    ).toEqual(['code', 'docs', 'gitleaks'])
  })
})

describe('lefthook v2 real pre-push boundaries', () => {
  test('skips a documentation-only update on an existing branch', async () => {
    const fixture = await makeHookFixture()
    await writeFile(join(fixture.work, 'README.md'), '# docs update\n')
    await commit(fixture, 'docs update', ['README.md'])

    expect(await push(fixture)).toEqual([])
  })

  test('skips a documentation-only update on a new branch', async () => {
    const fixture = await makeHookFixture()
    run(['git', 'switch', '-c', 'docs-only'], fixture.work)
    await writeFile(join(fixture.work, 'README.md'), '# branch docs update\n')
    await commit(fixture, 'branch docs update', ['README.md'])

    expect(await push(fixture, ['origin', 'docs-only'])).toEqual([])
  })

  test('runs validation for a code update', async () => {
    const fixture = await makeHookFixture()
    await writeFile(join(fixture.work, 'src', 'app.ts'), 'export const changed = true\n')
    await commit(fixture, 'code update', ['src/app.ts'])

    expect(await push(fixture)).toEqual(['validation'])
  })

  test('skips a deletion-only push', async () => {
    const fixture = await makeHookFixture()
    run(['git', 'branch', 'obsolete'], fixture.work)
    run(['git', 'push', '--no-verify', 'origin', 'obsolete'], fixture.work)

    expect(await push(fixture, ['origin', '--delete', 'obsolete'])).toEqual([])
  })

  test('runs validation when a code file is deleted', async () => {
    const fixture = await makeHookFixture()
    await rm(join(fixture.work, 'src', 'app.ts'))
    await commit(fixture, 'delete code', ['src/app.ts'])

    expect(await push(fixture)).toEqual(['validation'])
  })

  test('runs validation when code is renamed to documentation', async () => {
    const fixture = await makeHookFixture()
    await mkdir(join(fixture.work, 'docs'), { recursive: true })
    await rename(join(fixture.work, 'src', 'app.ts'), join(fixture.work, 'docs', 'app.md'))
    await commit(fixture, 'rename code to docs', ['src/app.ts', 'docs/app.md'])

    expect(await push(fixture)).toEqual(['validation'])
  })

  test('runs validation once when any ref in a multi-ref push changes code', async () => {
    const fixture = await makeHookFixture()
    run(['git', 'switch', '-c', 'docs-ref'], fixture.work)
    await writeFile(join(fixture.work, 'README.md'), '# multi-ref docs update\n')
    await commit(fixture, 'multi-ref docs', ['README.md'])
    run(['git', 'switch', 'main'], fixture.work)
    run(['git', 'switch', '-c', 'code-ref'], fixture.work)
    await writeFile(join(fixture.work, 'src', 'app.ts'), 'export const multiRef = true\n')
    await commit(fixture, 'multi-ref code', ['src/app.ts'])

    expect(
      await push(fixture, [
        'origin',
        'docs-ref:refs/heads/docs-ref',
        'code-ref:refs/heads/code-ref',
      ])
    ).toEqual(['validation'])
  })

  test('fails safe by running validation for malformed or empty stdin', async () => {
    const fixture = await makeHookFixture()
    const command = [
      'bun',
      'scripts/run-if-code-changed.ts',
      'pre-push',
      'validation',
      '--',
      'hook-probe',
      'validation',
    ]

    for (const stdin of [
      '',
      'malformed input\n',
      `(delete) 0 refs/heads/obsolete ${'a'.repeat(40)}\n`,
    ]) {
      await writeFile(fixture.logPath, '')
      const result = Bun.spawnSync(command, {
        cwd: fixture.work,
        env: { ...process.env, ...hookEnvironment(fixture) },
        stdin: Buffer.from(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(await readInvocations(fixture.logPath)).toEqual(['validation'])
    }
  })
})
