import { afterEach, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

// Failure modes are specified in T-11729: unpublished lock, foreign history,
// skipped commit, rejected push, notification failure and source/activation mixup.
const roots: string[] = []
const repo = resolve(import.meta.dir, '..')
const helper = join(repo, 'scripts/sync-hrc-downstream.sh')
const locatedJust = Bun.which('just')
if (!locatedJust) throw new Error('installed just is required')
// Resolve wrkp's known shim before fixture PATH puts a consumer `just` first.
// Otherwise that shim mistakes the fixture pull-deps entrypoint for real just.
const realJust = readFileSync(locatedJust).subarray(0, 128).toString().includes('# just shim')
  ? Bun.which('just', {
      PATH: (process.env.PATH ?? '')
        .split(delimiter)
        .filter((dir) => resolve(dir) !== dirname(locatedJust))
        .join(delimiter),
    })
  : locatedJust
if (!realJust) throw new Error('installed just backend is required')
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_INDEX_FILE: undefined,
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function command(args: string[], cwd: string, env = gitEnv) {
  const result = Bun.spawnSync(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  return { exit: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}
function git(cwd: string, ...args: string[]): string {
  const result = command(['git', ...args], cwd)
  if (result.exit !== 0) throw new Error(result.err)
  return result.out.trim()
}
function fixture(mode = 'advance') {
  const root = mkdtempSync('/tmp/asp-sync-')
  roots.push(root)
  const work = join(root, 'hrc-runtime')
  const remote = join(root, 'origin.git')
  const bin = join(root, 'bin')
  mkdirSync(work)
  mkdirSync(bin)
  git(root, 'init', '--bare', remote)
  git(work, 'init', '-b', 'main')
  git(work, 'config', 'user.name', 'Sync fixture')
  git(work, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(work, 'bun.lock'), 'initial\n')
  git(work, 'add', 'bun.lock')
  git(work, 'commit', '-m', 'initial')
  git(work, 'remote', 'add', 'origin', remote)
  git(work, 'push', '-u', 'origin', 'main')
  const initial = git(work, 'rev-parse', 'HEAD')
  const executable = (name: string, body: string) => {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`)
    chmodSync(path, 0o755)
  }
  executable(
    'just',
    `test "$*" = 'pull-deps'
printf 'pull\\n' >> "$SYNC_EVENTS"
if [[ "$SYNC_CASE" == noop ]]; then exit 0; fi
printf 'advanced\\n' > bun.lock
if [[ "$SYNC_CASE" == dirty ]]; then exit 0; fi
git add bun.lock
if [[ "$SYNC_CASE" == staged ]]; then exit 0; fi
if [[ "$SYNC_CASE" == foreign ]]; then
  printf 'foreign\\n' > other.txt
  git add other.txt
fi
git commit -m 'chore: sync bun.lock (ASP@fixture)' -- bun.lock
if [[ "$SYNC_CASE" == foreign ]]; then git commit -m foreign -- other.txt; fi`
  )
  executable(
    'bun',
    `test "$*" = 'run build'
printf 'build\\n' >> "$SYNC_EVENTS"
if [[ "$SYNC_CASE" == build-failure ]]; then exit 8; fi`
  )
  executable(
    'wrkc',
    `printf 'notify %s\\n' "$*" >> "$SYNC_EVENTS"
if [[ "$SYNC_CASE" == notify-failure ]]; then exit 9; fi`
  )
  const env = {
    ...gitEnv,
    PATH: `${bin}:${process.env.PATH}`,
    SYNC_CASE: mode,
    SYNC_EVENTS: join(root, 'events'),
  }
  return { root, work, remote, bin, initial, env }
}
function exercise(f: ReturnType<typeof fixture>, args = ['bash', helper, f.work], cwd = repo) {
  const result = command(args, cwd, f.env)
  const remote = git(f.remote, 'rev-parse', 'refs/heads/main')
  let events = ''
  try {
    events = readFileSync(join(f.root, 'events'), 'utf8')
  } catch {}
  const evidence = {
    case: f.env.SYNC_CASE,
    ...result,
    initial: f.initial,
    remote,
    head: git(f.work, 'rev-parse', 'HEAD'),
    lockStatus: git(f.work, 'status', '--porcelain', '--', 'bun.lock'),
    events,
  }
  if (process.env['ASP_DOWNSTREAM_EVIDENCE'])
    appendFileSync(process.env['ASP_DOWNSTREAM_EVIDENCE'], `${JSON.stringify(evidence)}\n`)
  return evidence
}
test('pushes generated lock commit to a real bare origin and notifies HRC before build', () => {
  const f = fixture()
  const result = exercise(f)
  expect(result.exit).toBe(0)
  expect(result.remote).toBe(result.head)
  expect(result.remote).not.toBe(f.initial)
  expect(result.lockStatus).toBe('')
  expect(result.events).toContain(result.remote)
  expect(result.events).toContain('mable@hrc-runtime:primary')
  expect(result.events.indexOf('notify')).toBeLessThan(result.events.indexOf('build'))
})
test('clean unchanged pull succeeds without push or notification', () => {
  const f = fixture('noop')
  const result = exercise(f)
  expect(result.exit).toBe(0)
  expect(result.remote).toBe(f.initial)
  expect(result.events).toBe('pull\nbuild\n')
})
for (const mode of ['dirty', 'staged'])
  test(`refuses a successful pull with uncommitted ${mode} lock`, () => {
    const f = fixture(mode)
    const result = exercise(f)
    expect(result.exit).not.toBe(0)
    expect(result.remote).toBe(f.initial)
    expect(result.events).not.toContain('build')
    expect(result.err).toContain('bun.lock')
  })
test('refuses pre-existing unpublished consumer history without running pull', () => {
  const f = fixture()
  git(f.work, 'commit', '--allow-empty', '-m', 'unrelated work')
  const result = exercise(f)
  expect(result.exit).not.toBe(0)
  expect(result.remote).toBe(f.initial)
  expect(result.events).toBe('')
})
test('refuses dirty lock before running pull', () => {
  const f = fixture()
  writeFileSync(join(f.work, 'bun.lock'), 'owner work\n')
  const result = exercise(f)
  expect(result.exit).not.toBe(0)
  expect(result.remote).toBe(f.initial)
  expect(result.events).toBe('')
})
test('refuses inherited alternate index before mutation', () => {
  const f = fixture()
  Object.assign(f.env, { GIT_INDEX_FILE: join(f.root, 'alternate-index') })
  const result = exercise(f)
  expect(result.exit).not.toBe(0)
  expect(result.events).toBe('')
})
test('refuses unrelated concurrent history created during pull', () => {
  const f = fixture('foreign')
  const result = exercise(f)
  expect(result.exit).not.toBe(0)
  expect(result.remote).toBe(f.initial)
  expect(result.events).not.toContain('notify')
  expect(result.events).not.toContain('build')
})
test('push rejection fails visibly before owner notification and build', () => {
  const f = fixture()
  const hook = join(f.remote, 'hooks/pre-receive')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  chmodSync(hook, 0o755)
  const result = exercise(f)
  expect(result.exit).not.toBe(0)
  expect(result.remote).toBe(f.initial)
  expect(result.err).toContain(result.head)
  expect(result.events).not.toContain('build')
})
test('notification failure reports an already-pushed commit and fails before build', () => {
  const f = fixture('notify-failure')
  const result = exercise(f)
  expect(result.exit).not.toBe(0)
  expect(result.remote).toBe(result.head)
  expect(result.remote).not.toBe(f.initial)
  expect(result.err).toContain(result.head)
  expect(result.err).toContain('notify')
  expect(result.events).not.toContain('build')
})
test('only captured lock SHA is pushed if HEAD advances in pre-push hook', () => {
  const f = fixture()
  const hook = join(f.work, '.git/hooks/pre-push')
  writeFileSync(hook, '#!/bin/sh\ngit commit --allow-empty -m concurrent-local\n')
  chmodSync(hook, 0o755)
  const result = exercise(f)
  expect(result.exit).toBe(0)
  expect(result.remote).not.toBe(result.head)
  expect(git(f.work, 'rev-parse', `${result.head}^`)).toBe(result.remote)
  expect(result.events).toContain(result.remote)
})
test('build failure does not conceal delivery or run HRC activation', () => {
  const f = fixture('build-failure')
  const result = exercise(f)
  expect(result.exit).not.toBe(0)
  expect(result.remote).toBe(result.head)
  expect(result.events).toContain('notify')
  expect(result.events).toContain('build')
  expect(result.events).not.toContain('install')
})
test('installed just sync-downstream recipe delivers a scratch consumer', () => {
  const f = fixture()
  const producer = join(f.root, 'producer')
  mkdirSync(join(producer, 'scripts'), { recursive: true })
  copyFileSync(join(repo, 'justfile'), join(producer, 'justfile'))
  copyFileSync(helper, join(producer, 'scripts/sync-hrc-downstream.sh'))
  git(producer, 'init', '-b', 'main')
  const result = exercise(
    f,
    [realJust, '--justfile', join(producer, 'justfile'), 'sync-downstream'],
    producer
  )
  expect(result.exit).toBe(0)
  expect(result.remote).toBe(result.head)
  expect(result.events).toContain('notify')
})

test('a failed post-pull lock inspection cannot look like a clean unchanged pull', () => {
  const f = fixture('noop')
  const realGit = Bun.which('git')
  if (!realGit) throw new Error('git is required')
  const wrapper = join(f.bin, 'git')
  writeFileSync(
    wrapper,
    `#!/bin/bash\nif [[ "$1" == status && -s "$SYNC_EVENTS" ]]; then exit 13; fi\nexec "$SYNC_REAL_GIT" "$@"\n`
  )
  chmodSync(wrapper, 0o755)
  Object.assign(f.env, { SYNC_REAL_GIT: realGit })
  const result = exercise(f)
  expect(result.exit).not.toBe(0)
  expect(result.remote).toBe(f.initial)
  expect(result.events).not.toContain('build')
})
