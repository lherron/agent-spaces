/**
 * prepareMuseHome tests (spikes 8 + 10): HOME skills fallback seeding and
 * warning-never-error auth seeding.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { museHomeEnv, prepareMuseHome } from './prepare-home.js'

describe('prepareMuseHome', () => {
  test('materializes skills and lints SKILL.md frontmatter', async () => {
    const base = await mkdtemp(join(tmpdir(), 'muse-home-'))
    try {
      const skills = join(base, 'skills')
      await mkdir(join(skills, 'good'), { recursive: true })
      await writeFile(
        join(skills, 'good', 'SKILL.md'),
        '---\nname: good\ndescription: Good skill.\n---\n\n# Good\n'
      )
      await mkdir(join(skills, 'broken'), { recursive: true })
      await writeFile(join(skills, 'broken', 'SKILL.md'), '# No frontmatter\n')
      const home = await prepareMuseHome('inv-test-1', {
        baseDir: base,
        workspaceSkillsDir: skills,
        operatorHome: base,
      })
      expect(await readFile(join(home.configDir, 'skills', 'good', 'SKILL.md'), 'utf-8')).toContain(
        '# Good'
      )
      expect(home.warnings.some((warning) => warning.includes('invalid-skill-package'))).toBe(true)
      expect(home.warnings.some((warning) => warning.includes('auth.json not found'))).toBe(true)
      expect(museHomeEnv(home).HOME).toBe(home.home)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('operator mode keeps $HOME and isolates only the XDG dirs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'muse-home-'))
    try {
      const operator = join(base, 'operator')
      const operatorConfig = join(operator, '.config', 'muse')
      await mkdir(operatorConfig, { recursive: true })
      await writeFile(join(operatorConfig, 'auth.json'), '{"token":"x"}\n')
      const home = await prepareMuseHome('inv-test-op', {
        baseDir: base,
        homeMode: 'operator',
        operatorHome: operator,
      })
      expect(home.home).toBe(operator)
      expect(home.configDir).toBe(join(base, 'muse-serve-xdg-inv-test-op', '.config', 'muse'))
      expect(home.dataDir).toBe(join(base, 'muse-serve-xdg-inv-test-op', '.local', 'share', 'muse'))
      const env = museHomeEnv(home)
      expect(env['HOME']).toBe(operator)
      expect(env['XDG_CONFIG_HOME']).toBe(join(base, 'muse-serve-xdg-inv-test-op', '.config'))
      expect(env['XDG_DATA_HOME']).toBe(join(base, 'muse-serve-xdg-inv-test-op', '.local', 'share'))
      expect(await readFile(join(home.configDir, 'auth.json'), 'utf-8')).toContain('token')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('operator mode treats homeDir as the stable scratch root, never $HOME', async () => {
    const base = await mkdtemp(join(tmpdir(), 'muse-home-'))
    try {
      const operator = join(base, 'operator')
      await mkdir(join(operator, '.config', 'muse'), { recursive: true })
      const stable = join(base, 'stable')
      const home = await prepareMuseHome('inv-test-opstable', {
        homeDir: stable,
        homeMode: 'operator',
        operatorHome: operator,
      })
      expect(home.home).toBe(operator)
      expect(home.configDir).toBe(join(stable, '.config', 'muse'))
      expect(museHomeEnv(home).HOME).toBe(operator)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('symlinks operator auth.json when present', async () => {
    const base = await mkdtemp(join(tmpdir(), 'muse-home-'))
    try {
      const operatorConfig = join(base, 'operator', '.config', 'muse')
      await mkdir(operatorConfig, { recursive: true })
      await writeFile(join(operatorConfig, 'auth.json'), '{"token":"x"}\n')
      const home = await prepareMuseHome('inv-test-2', {
        baseDir: base,
        operatorHome: join(base, 'operator'),
      })
      expect(await readFile(join(home.configDir, 'auth.json'), 'utf-8')).toContain('token')
      expect(home.warnings.some((warning) => warning.includes('auth.json not found'))).toBe(false)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
