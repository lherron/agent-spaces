/**
 * `asp repo` / `asp spaces` against a temp shared spaces root (T-10367).
 *
 * WHY: The git registry was retired in T-04144. `asp repo publish/tags/gc` are
 * gone; init/new-space/status and `asp spaces init/list` read and write
 * `<root>/spaces/` directly. These run the real CLI against a temp root passed
 * with --registry so the live agents root is never touched.
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getManagerSpaceFiles } from '../manager-space-content'

const ASP_CLI = join(import.meta.dirname, '..', '..', '..', '..', 'bin', 'asp.js')
const CLI_TEST_TIMEOUT_MS = 60_000

type RunResult = { stdout: string; stderr: string; exitCode: number }

function runAsp(args: string[]): RunResult {
  try {
    const stdout = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: CLI_TEST_TIMEOUT_MS,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err
    const stdout = 'stdout' in err ? err.stdout : undefined
    const stderr = 'stderr' in err ? err.stderr : undefined
    const status = 'status' in err ? err.status : undefined
    return {
      stdout: typeof stdout === 'string' || Buffer.isBuffer(stdout) ? stdout.toString() : '',
      stderr: typeof stderr === 'string' || Buffer.isBuffer(stderr) ? stderr.toString() : '',
      exitCode: typeof status === 'number' ? status : 1,
    }
  }
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'asp-root-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('asp repo surface after registry retirement', () => {
  test(
    'help lists only init, new-space and status',
    () => {
      const result = runAsp(['repo', '--help'])
      expect(result.exitCode).toBe(0)
      const commands = [...result.stdout.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1])
      expect(commands.filter((c) => c !== 'help').sort()).toEqual(['init', 'new-space', 'status'])
      expect(result.stdout).not.toMatch(/registry|dist-tag/i)
    },
    CLI_TEST_TIMEOUT_MS
  )

  for (const removed of ['publish', 'tags', 'gc']) {
    test(
      `asp repo ${removed} is an unknown command`,
      () => {
        const result = runAsp(['repo', removed, 'some-space'])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain(`unknown command '${removed}'`)
      },
      CLI_TEST_TIMEOUT_MS
    )
  }
})

describe('asp repo init', () => {
  test(
    'creates spaces/ and installs the embedded manager space, no git or dist-tags',
    async () => {
      await withRoot(async (root) => {
        const result = runAsp(['repo', 'init', '--registry', root])
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('asp run space:agent-spaces-manager@dev')

        const spaceDir = join(root, 'spaces', 'agent-spaces-manager')
        for (const file of getManagerSpaceFiles()) {
          expect(await readFile(join(spaceDir, file.path), 'utf8')).toBe(file.content)
        }
        expect(await Bun.file(join(root, '.git', 'HEAD')).exists()).toBe(false)
        expect(await Bun.file(join(root, 'registry', 'dist-tags.json')).exists()).toBe(false)
      })
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    'leaves an existing manager space untouched',
    async () => {
      await withRoot(async (root) => {
        expect(runAsp(['repo', 'init', '--registry', root]).exitCode).toBe(0)
        const toml = join(root, 'spaces', 'agent-spaces-manager', 'space.toml')
        await writeFile(toml, 'edited\n')

        const again = runAsp(['repo', 'init', '--registry', root])
        expect(again.exitCode).toBe(0)
        expect(again.stdout).toContain('Manager space already present')
        expect(await readFile(toml, 'utf8')).toBe('edited\n')
      })
    },
    CLI_TEST_TIMEOUT_MS
  )
})

describe('asp repo status', () => {
  test(
    'refuses when the root has no spaces/ dir',
    async () => {
      await withRoot(async (root) => {
        const result = runAsp(['repo', 'status', '--registry', root])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain(`No shared spaces dir at ${root}/spaces`)
      })
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    'reports spaces and git null outside a git checkout',
    async () => {
      await withRoot(async (root) => {
        await mkdir(join(root, 'spaces', 'beta'), { recursive: true })
        await mkdir(join(root, 'spaces', 'alpha'), { recursive: true })

        const result = runAsp(['repo', 'status', '--json', '--registry', root])
        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({
          spacesRoot: root,
          spaces: ['alpha', 'beta'],
          git: null,
        })
      })
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    'reports uncommitted edits under spaces/ only',
    async () => {
      await withRoot(async (root) => {
        git(['init', '-q', '-b', 'main'], root)
        git(['config', 'user.email', 't@example.invalid'], root)
        git(['config', 'user.name', 't'], root)
        await mkdir(join(root, 'spaces', 'alpha'), { recursive: true })
        await writeFile(join(root, 'spaces', 'alpha', 'space.toml'), 'schema = 1\n')
        git(['add', '.'], root)
        git(['commit', '-q', '-m', 'init'], root)

        const clean = JSON.parse(runAsp(['repo', 'status', '--json', '--registry', root]).stdout)
        expect(clean.git).toEqual({ branch: 'main', changes: [] })

        await writeFile(join(root, 'spaces', 'alpha', 'space.toml'), 'schema = 2\n')
        await writeFile(join(root, 'outside.txt'), 'not a space\n')
        const dirty = JSON.parse(runAsp(['repo', 'status', '--json', '--registry', root]).stdout)
        expect(dirty.git).toEqual({ branch: 'main', changes: [' M spaces/alpha/space.toml'] })
      })
    },
    CLI_TEST_TIMEOUT_MS
  )
})

describe('asp repo new-space / asp spaces against the shared root', () => {
  test(
    'new-space refuses when the root has no spaces/ dir',
    async () => {
      await withRoot(async (root) => {
        const result = runAsp(['repo', 'new-space', 'orphan', '--registry', root])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain('No shared spaces dir')
        expect(await Bun.file(join(root, 'spaces', 'orphan', 'space.toml')).exists()).toBe(false)
      })
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    'spaces list reads the shared root without dist-tags',
    async () => {
      await withRoot(async (root) => {
        expect(runAsp(['repo', 'init', '--no-manager', '--registry', root]).exitCode).toBe(0)
        const created = runAsp(['spaces', 'init', 'listed', '-d', 'Listed', '--registry', root])
        expect(created.exitCode).toBe(0)
        expect(created.stdout).toContain('space:listed@dev')
        expect(created.stdout).not.toContain('asp repo publish')

        const result = runAsp(['spaces', 'list', '--json', '--registry', root])
        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({
          spacesRoot: root,
          spaces: [
            {
              id: 'listed',
              version: '0.1.0',
              description: 'Listed',
              path: `${root}/spaces/listed`,
            },
          ],
        })
      })
    },
    CLI_TEST_TIMEOUT_MS
  )
})
