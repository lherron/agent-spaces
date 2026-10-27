import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = join(import.meta.dir, 'install-policy.ts')

// Git variables a hook run would leak into the child and point it at the wrong repo.
const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...cleanEnv } = process.env

let root = ''
let mainCheckout = ''
let linkedWorktree = ''

function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, env: cleanEnv, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'asp-install-policy-'))
  mainCheckout = join(root, 'main')
  linkedWorktree = join(root, 'linked')
  git(['init', '-q', '-b', 'main', mainCheckout], root)
  git(
    [
      '-c',
      'user.name=Install Policy',
      '-c',
      'user.email=install-policy@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'baseline',
    ],
    mainCheckout
  )
  git(['worktree', 'add', '-q', '-b', 'linked', linkedWorktree], mainCheckout)
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function shell(
  checkout: 'main' | 'linked',
  flags: string[]
): { status: number | null; vars: Record<string, string>; stderr: string } {
  const result = spawnSync('bun', [script, 'shell', ...flags], {
    cwd: checkout === 'main' ? mainCheckout : linkedWorktree,
    env: cleanEnv,
    encoding: 'utf8',
  })
  const vars: Record<string, string> = {}
  for (const line of result.stdout.split('\n')) {
    const match = /^(PRAESIDIUM_INSTALL_[A-Z_]+)='(.*)'$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) vars[match[1]] = match[2]
  }
  return { status: result.status, vars, stderr: result.stderr }
}

function policy(
  context: string,
  sync: string,
  link: string,
  channel: string,
  tag: string
): Record<string, string> {
  return {
    PRAESIDIUM_INSTALL_CONTEXT: context,
    PRAESIDIUM_INSTALL_SYNC_MODE: sync,
    PRAESIDIUM_INSTALL_LINK_MODE: link,
    PRAESIDIUM_INSTALL_PUBLISH_CHANNEL: channel,
    PRAESIDIUM_INSTALL_PUBLISH_TAG: tag,
  }
}

describe('install-policy.ts shell', () => {
  test.each([
    {
      name: 'a main checkout keeps sync and linking on and publishes canonical latest',
      checkout: 'main' as const,
      flags: [],
      expected: policy('main', 'on', 'on', 'canonical', 'latest'),
    },
    {
      name: 'a linked worktree turns sync and linking off and publishes to the worktree channel',
      checkout: 'linked' as const,
      flags: [],
      expected: policy('linked-worktree', 'off', 'off', 'worktree', 'worktree'),
    },
    {
      name: '--no-sync turns sync off in a main checkout',
      checkout: 'main' as const,
      flags: ['--no-sync=1'],
      expected: policy('main', 'off', 'on', 'canonical', 'latest'),
    },
    {
      name: 'force options turn sync and linking on loudly in a linked worktree',
      checkout: 'linked' as const,
      flags: ['--force-sync=1', '--force-link=true'],
      expected: policy('linked-worktree', 'forced', 'forced', 'worktree', 'worktree'),
    },
  ])('$name', ({ checkout, flags, expected }) => {
    const result = shell(checkout, flags)
    expect(result.status, result.stderr).toBe(0)
    expect(result.vars).toEqual(expected)
  })

  test('contradictory --no-sync and --force-sync exit non-zero without emitting a policy', () => {
    const result = shell('linked', ['--no-sync=1', '--force-sync=1'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/no-sync and force-sync/)
    expect(result.vars).toEqual({})
  })
})
