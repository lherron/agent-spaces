/**
 * Contract tests for the pinned-dependency agreement guard and the workspace doctor.
 *
 * WHAT WOULD FLATTEN THESE: the cheap version of this guard is "reject the literal
 * string 'latest' in any manifest". That passes the positive case and fails
 * everything that matters — it flags a floating specifier on an UNGOVERNED
 * dependency (bun nests those on purpose), and it misses a caret or a wrong exact
 * version on a governed one, which shadows the root just as effectively. The
 * negative controls below pin the RELATION (declared specifier === root overrides
 * pin, for governed dependencies only) so a flattened rewrite goes red.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guard } from './check-dependency-pins.ts'
import { assertGuardDiagnostics } from './lib/boundary-guard/test-helper.ts'

const doctorScript = join(import.meta.dir, 'workspace-doctor.ts')

function rootManifest(overrides: Record<string, string>): string {
  return `${JSON.stringify({ name: 'fixture', private: true, overrides }, null, 2)}\n`
}

function memberManifest(devDependencies: Record<string, string>): string {
  return `${JSON.stringify({ name: 'fixture-member', devDependencies }, null, 2)}\n`
}

/** Every fixture needs one non-manifest file so the surface is never empty. */
const sourceFile = { rel: 'contracts/member/src/index.ts', content: 'export const value = 1\n' }

describe('check-dependency-pins', () => {
  test('flags a governed dependency declared with a floating specifier', async () => {
    const { diagnostics } = await assertGuardDiagnostics(guard, {
      expectExit: 1,
      files: [
        { rel: 'package.json', content: rootManifest({ '@types/bun': '1.3.14' }) },
        {
          rel: 'contracts/member/package.json',
          content: memberManifest({ '@types/bun': 'latest' }),
        },
        sourceFile,
      ],
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.ruleId).toBe('PINS:unpinned-governed-dependency')
    expect(diagnostics[0]?.location.file).toBe('contracts/member/package.json')
    // The line must point at the declaration itself, not the top of the manifest.
    expect(diagnostics[0]?.location.line).toBe(4)
    expect(diagnostics[0]?.got).toContain('"latest"')
  })

  test('flags a governed dependency declared as a range that resolves elsewhere', async () => {
    const { diagnostics } = await assertGuardDiagnostics(guard, {
      expectExit: 1,
      files: [
        { rel: 'package.json', content: rootManifest({ '@types/bun': '1.3.14' }) },
        {
          rel: 'contracts/member/package.json',
          content: memberManifest({ '@types/bun': '^1.1.14' }),
        },
        sourceFile,
      ],
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.got).toContain('"^1.1.14"')
  })

  test('accepts a governed dependency declared at exactly the pinned version', async () => {
    await assertGuardDiagnostics(guard, {
      expectExit: 0,
      files: [
        { rel: 'package.json', content: rootManifest({ '@types/bun': '1.3.14' }) },
        {
          rel: 'contracts/member/package.json',
          content: memberManifest({ '@types/bun': '1.3.14' }),
        },
        sourceFile,
      ],
    })
  })

  // NEGATIVE CONTROL: this is not a ban on floating specifiers. Only what the root
  // pins is governed; bun nests ungoverned packages deliberately to satisfy real
  // range conflicts, and flagging those would make the guard unusable.
  test('ignores a floating specifier on a dependency the root does not pin', async () => {
    await assertGuardDiagnostics(guard, {
      expectExit: 0,
      files: [
        { rel: 'package.json', content: rootManifest({ '@types/bun': '1.3.14' }) },
        { rel: 'contracts/member/package.json', content: memberManifest({ marked: 'latest' }) },
        sourceFile,
      ],
    })
  })

  // NEGATIVE CONTROL: an override that is itself a range states a constraint, not a
  // single resolution, so it cannot demand exact agreement from members.
  test('ignores an override entry that is not one exact version', async () => {
    await assertGuardDiagnostics(guard, {
      expectExit: 0,
      files: [
        { rel: 'package.json', content: rootManifest({ '@types/bun': '^1.3.0' }) },
        {
          rel: 'contracts/member/package.json',
          content: memberManifest({ '@types/bun': 'latest' }),
        },
        sourceFile,
      ],
    })
  })

  test("governs the root manifest's own declarations", async () => {
    const { diagnostics } = await assertGuardDiagnostics(guard, {
      expectExit: 1,
      files: [
        {
          rel: 'package.json',
          content: `${JSON.stringify(
            {
              name: 'fixture',
              private: true,
              overrides: { '@types/bun': '1.3.14' },
              devDependencies: { '@types/bun': 'latest' },
            },
            null,
            2
          )}\n`,
        },
        sourceFile,
      ],
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.location.file).toBe('package.json')
  })
})

type DoctorTree = {
  root: string
  run: (...args: string[]) => { exitCode: number; output: string }
}

async function makeDoctorTree(
  copies: { rel: string; version: string }[],
  overrides: Record<string, string> = { '@types/bun': '1.3.14' }
): Promise<DoctorTree> {
  const root = await mkdtemp(join(tmpdir(), 'workspace-doctor-'))
  await writeFile(join(root, 'package.json'), rootManifest(overrides), 'utf8')

  for (const copy of copies) {
    const dir = join(root, copy.rel)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: '@types/bun', version: copy.version })}\n`,
      'utf8'
    )
  }

  return {
    root,
    run(...args: string[]) {
      const result = Bun.spawnSync(['bun', doctorScript, '--root', root, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return {
        exitCode: result.exitCode,
        output: `${result.stdout.toString()}${result.stderr.toString()}`,
      }
    },
  }
}

describe('workspace-doctor', () => {
  test('reports and prunes a nested copy that shadows the root resolution', async () => {
    const tree = await makeDoctorTree([
      { rel: 'node_modules/@types/bun', version: '1.3.14' },
      { rel: 'harness/broker/node_modules/@types/bun', version: '1.4.0' },
    ])

    try {
      const reported = tree.run('--check')
      expect(reported.exitCode).toBe(1)
      expect(reported.output).toContain('harness/broker/node_modules/@types/bun@1.4.0')
      // --check must not delete: the nested copy is still there for the real run.
      expect(
        await Bun.file(
          join(tree.root, 'harness/broker/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeTrue()

      const pruned = tree.run()
      expect(pruned.exitCode).toBe(0)
      expect(pruned.output).toContain('pruned 1 stale nested copy')
      expect(
        await Bun.file(
          join(tree.root, 'harness/broker/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeFalse()
      // The root resolution is never a prune target.
      expect(
        await Bun.file(join(tree.root, 'node_modules/@types/bun/package.json')).exists()
      ).toBeTrue()
    } finally {
      await rm(tree.root, { recursive: true, force: true })
    }
  })

  test('keeps a nested copy that matches the root resolution', async () => {
    const tree = await makeDoctorTree([
      { rel: 'node_modules/@types/bun', version: '1.3.14' },
      { rel: 'harness/broker/node_modules/@types/bun', version: '1.3.14' },
    ])

    try {
      expect(tree.run().exitCode).toBe(0)
      expect(
        await Bun.file(
          join(tree.root, 'harness/broker/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeTrue()
    } finally {
      await rm(tree.root, { recursive: true, force: true })
    }
  })

  // NEGATIVE CONTROL: without a root resolution there is nothing to shadow, and
  // deleting the only copy would break the install rather than repair it.
  test('keeps a nested copy when the root has no resolution to compare against', async () => {
    const tree = await makeDoctorTree([
      { rel: 'harness/broker/node_modules/@types/bun', version: '1.4.0' },
    ])

    try {
      const result = tree.run()
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('no root resolution to compare against; kept')
      expect(
        await Bun.file(
          join(tree.root, 'harness/broker/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeTrue()
    } finally {
      await rm(tree.root, { recursive: true, force: true })
    }
  })

  test('never touches a dependency the root does not pin', async () => {
    const tree = await makeDoctorTree(
      [
        { rel: 'node_modules/@types/bun', version: '1.3.14' },
        { rel: 'harness/broker/node_modules/@types/bun', version: '1.4.0' },
      ],
      { 'some-other-package': '2.0.0' }
    )

    try {
      expect(tree.run().exitCode).toBe(0)
      expect(
        await Bun.file(
          join(tree.root, 'harness/broker/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeTrue()
    } finally {
      await rm(tree.root, { recursive: true, force: true })
    }
  })
})
