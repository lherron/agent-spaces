import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preparePathFilter } from '../../compiler/agent-spaces/src/path-filter.js'

test('shell PATH filter survives rc reconstruction, nested shells, refresh and concurrent births', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asp-path-filter-'))
  try {
    const home = join(root, 'home')
    const bin = join(root, 'source bin')
    await mkdir(home)
    await mkdir(bin)
    for (const name of ['wrkq', 'allowed', '.hidden', '.stamp', '.source']) {
      await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n')
      await chmod(join(bin, name), 0o755)
    }
    for (const rc of ['zshenv', 'zprofile', 'zshrc', 'zlogin']) {
      await writeFile(join(home, `.${rc}`), `path=("${bin}" $path)\n`)
    }
    const zdotdir = await preparePathFilter(root, ['wrkq'], true)
    const run = async (mode: string, command: string) => {
      const proc = Bun.spawn(['/bin/zsh', mode, command], {
        env: { HOME: home, ZDOTDIR: zdotdir, PATH: `${bin}:/usr/bin:/bin` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(err).toBe('')
      expect(status).toBe(0)
      return out
    }
    const check = '(( ! $+commands[wrkq] )); command -v allowed; command -v .hidden'
    for (const mode of ['-c', '-lc', '-lic']) {
      expect(await run(mode, check)).toContain('/farm/')
      expect(await run(mode, 'print -l -- $path')).not.toMatch(/^%2f/m)
    }
    expect(
      await run(
        '-c',
        "zsh -c 'command -v wrkq'; bash -c 'command -v wrkq'; sh -c 'command -v wrkq'; true"
      )
    ).toBe('')
    await preparePathFilter(root, ['wrkq'], true)
    await Promise.all(Array.from({ length: 8 }, () => run('-c', check)))
    expect(await run('-c', 'command -v .stamp; command -v .source')).toContain('/farm/')
    await writeFile(join(bin, 'new-command'), '#!/bin/sh\nexit 0\n')
    await chmod(join(bin, 'new-command'), 0o755)
    expect(await run('-c', 'command -v new-command')).toContain('/farm/')
    await preparePathFilter(root, ['wrkq'], true)
    expect(await run('-c', 'command -v new-command')).toContain('/farm/')
    const before = await readFile(join(zdotdir, 'path-filter.zsh'), 'utf8')
    await preparePathFilter(root, ['wrkq'], false)
    expect(await readFile(join(zdotdir, 'path-filter.zsh'), 'utf8')).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
