/**
 * Tests for git archive extraction.
 *
 * WHY: extractTree once piped `git archive` into `tar` through Bun's
 * node:child_process streams and waited for both children's 'close'. Under
 * load, git's stdout sometimes never emitted 'end' after both processes had
 * exited, so git's 'close' never fired and extraction hung forever (T-10366).
 * The same pipe also dropped data, truncating tar's input. These
 * tests require large extractions to arrive intact and a consumer killed
 * mid-operation to fail extraction rather than hang it.
 *
 * Settlement is awaited directly, never through `expect(...).resolves` or
 * `.rejects`: on Bun 1.3.14 those busy-wait on a pending promise and ignore the
 * test timeout, so a regression would spin instead of failing.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { extractTree } from './archive.js'
import { add, commit, gitExec, initRepo } from './index.js'

const roots: string[] = []
const originalPath = process.env['PATH']

afterEach(async () => {
  process.env['PATH'] = originalPath
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

/** A repo whose archive is far larger than a pipe buffer, so git cannot finish unread. */
async function repoWithLargeSpace(): Promise<{ repo: string; sha: string }> {
  const repo = await tempRoot('asp-archive-repo')
  await mkdir(join(repo, 'spaces', 'big'), { recursive: true })
  await writeFile(join(repo, 'spaces', 'big', 'space.toml'), 'schema = 1\nid = "big"\n')
  await writeFile(join(repo, 'spaces', 'big', 'payload.bin'), Buffer.alloc(4 * 1024 * 1024, 7))
  await initRepo(repo, { initialBranch: 'main' })
  await gitExec(['config', 'user.email', 'archive@example.test'], { cwd: repo })
  await gitExec(['config', 'user.name', 'Archive Test'], { cwd: repo })
  await add(['spaces'], { cwd: repo })
  return { repo, sha: await commit('fixture', { cwd: repo }) }
}

/** Put a `tar` on PATH that kills itself after reading at most one byte. */
async function installDyingTar(): Promise<void> {
  const bin = await tempRoot('asp-archive-bin')
  const tar = join(bin, 'tar')
  await writeFile(tar, '#!/bin/sh\nhead -c 1 >/dev/null\nkill -9 $$\n')
  await chmod(tar, 0o755)
  process.env['PATH'] = [bin, originalPath].filter(Boolean).join(delimiter)
}

describe('extractTree', () => {
  // The piped implementation truncated a multi-megabyte archive about once in
  // twelve extractions; repeating makes that loss show up in a single run.
  test('extracts a large space subtree intact every time', async () => {
    const { repo, sha } = await repoWithLargeSpace()
    const destRoot = await tempRoot('asp-archive-dest')

    for (let attempt = 0; attempt < 50; attempt++) {
      const dest = join(destRoot, `out-${attempt}`)
      await extractTree(sha, 'spaces/big', dest, { cwd: repo })

      expect(await readFile(join(dest, 'space.toml'), 'utf8')).toContain('id = "big"')
      expect((await readFile(join(dest, 'payload.bin'))).length).toBe(4 * 1024 * 1024)
    }
  }, 30_000)

  test('fails instead of hanging when tar dies mid-stream', async () => {
    const { repo, sha } = await repoWithLargeSpace()
    const dest = join(await tempRoot('asp-archive-dest'), 'out')
    await installDyingTar()

    const error = await extractTree(sha, 'spaces/big', dest, { cwd: repo }).then(
      () => undefined,
      (err: unknown) => err
    )

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('Tar extraction failed')
  }, 10_000)
})
