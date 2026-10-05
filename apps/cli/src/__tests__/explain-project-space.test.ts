/**
 * `asp explain` lists a project space's composed content, read from the
 * project's spaces/ directory (T-10322: its skills were missing).
 */

import { afterEach, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cliTest, runAsp } from './asp-cli.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

cliTest('explain lists a project space skill', () => {
  const base = mkdtempSync(join(tmpdir(), 'asp-explain-'))
  dirs.push(base)
  const project = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  const skillDir = join(project, 'spaces', 'demo-space', 'skills', 'demo-skill')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(aspHome)
  writeFileSync(
    join(project, 'asp-targets.toml'),
    'schema = 2\n\n[targets.demo]\ncompose = ["space:project:demo-space"]\n'
  )
  writeFileSync(
    join(project, 'spaces', 'demo-space', 'space.toml'),
    'schema = 1\nid = "demo-space"\nversion = "0.1.0"\n'
  )
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: probe\n---\nhi\n')

  const env = { ASP_HOME: aspHome }
  expect(runAsp(['install', '--project', project], env).exitCode).toBe(0)

  const json = runAsp(['explain', 'demo', '--json', '--project', project], env)
  expect(json.exitCode).toBe(0)
  const target = (
    JSON.parse(json.stdout) as {
      targets: Record<string, { composed: { skills: Array<{ space: string; name: string }> } }>
    }
  ).targets['demo']
  expect(target?.composed.skills).toEqual([{ space: 'demo-space', name: 'demo-skill' }])

  const text = runAsp(['explain', 'demo', '--project', project], env)
  expect(text.exitCode).toBe(0)
  expect(text.stdout).toContain('demo-skill (from demo-space)')
})
