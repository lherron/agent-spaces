/**
 * Tests for the two-tier agent-hygiene linter (tier-1 W4xx rules, scan, baseline,
 * and the tier-2 judge core: prompt assembly + scorecard validation).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fingerprint, writeBaseline } from './baseline.js'
import { type Scorecard, buildJudgePrompt, validateScorecard } from './judge.js'
import { promptRegime, stripFrontmatter, wordCount } from './parse.js'
import { lintHygiene, runHygieneTarget } from './run.js'
import { scanHygieneTarget } from './scan.js'
import type { HygieneUnit } from './types.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'hygiene-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function writeSkill(
  dir: string,
  name: string,
  frontmatter: string,
  body: string
): Promise<string> {
  const skillDir = join(dir, name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
  return skillDir
}

function skillUnit(dir: string, content: string, fm: HygieneUnit['frontmatter']): HygieneUnit {
  return {
    kind: 'skill',
    key: 'test/skill:x',
    path: join(dir, 'SKILL.md'),
    dir,
    regime: 'on-demand',
    content,
    frontmatter: fm,
  }
}

describe('parse helpers', () => {
  it('strips frontmatter for the counted body region', () => {
    const body = stripFrontmatter('---\nname: x\n---\nhello world')
    expect(body).toBe('hello world')
    expect(wordCount(body)).toBe(2)
  })

  it('classifies prompt regime with the XL0 correction', () => {
    expect(promptRegime('AGENT_MOTD.md')).toBe('resident')
    expect(promptRegime('conventions.md')).toBe('resident')
    expect(promptRegime('SOUL.md')).toBe('resident')
    expect(promptRegime('USER.md')).toBe('boot')
  })
})

describe('W400 name==dirname', () => {
  it.each([
    { row: 'dir foo, name bar -> W400', dir: 'foo', name: 'bar', flagged: true },
    {
      row: 'dir foo-bar, name foo-bar -> no W400',
      dir: 'foo-bar',
      name: 'foo-bar',
      flagged: false,
    },
  ])(
    'a skill whose name differs from its directory is flagged W400: $row',
    async ({ dir, name, flagged }) => {
      const skillDir = await writeSkill(tempDir, dir, `name: ${name}\ndescription: d`, 'x')

      const result = await runHygieneTarget(skillDir)

      expect(result.warnings.filter((w) => w.code === 'W400')).toEqual(
        flagged
          ? [
              expect.objectContaining({
                code: 'W400',
                path: join(skillDir, 'SKILL.md'),
                message: expect.stringContaining(
                  `Skill name '${name}' does not match directory basename '${dir}'`
                ),
              }),
            ]
          : []
      )
    }
  )
})

describe('W41x tripwires', () => {
  it('flags model-name weld and human-in-the-loop, skipping fenced code', async () => {
    const body = [
      '# skill',
      'Test with Opus and Sonnet here.',
      'Then ask Lance before proceeding.',
      '```',
      'claude-5 in a code fence should be ignored',
      '```',
    ].join('\n')
    const skillDir = await writeSkill(tempDir, 'x', 'name: x\ndescription: d', body)
    const skillMd = join(skillDir, 'SKILL.md')

    const result = await runHygieneTarget(skillDir)

    // File lines: 1-4 frontmatter, 6 Opus/Sonnet, 7 ask Lance, 9 fenced claude-5 (skipped).
    // Every tripwire is advisory info.
    expect(result.warnings.map((w) => [w.code, w.severity, w.path])).toEqual([
      ['W415', 'info', `${skillMd}:6`],
      ['W417', 'info', `${skillMd}:7`],
    ])
  })
})

describe('scan + full run', () => {
  it('scans an agent root and detects the dead layer end-to-end', async () => {
    const root = join(tempDir, 'clod')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'agent-profile.toml'), 'id = "clod"\n')
    await writeFile(
      join(root, 'context-template.toml'),
      '[[prompt]]\npath = "agent-root:///SOUL.md"\n[[prompt]]\npath = "AGENT_MOTD.md"\n'
    )
    await writeFile(join(root, 'SOUL.md'), 'Clod code rules the world.\n')
    await writeFile(join(root, 'AGENTS.md'), 'Some SOP that lives only here.\n')
    await symlink('AGENTS.md', join(root, 'CLAUDE.md'))
    await writeSkill(
      join(root, 'skills'),
      'my-skill',
      'name: my-skill\ndescription: A skill.',
      'Body.'
    )

    const result = await runHygieneTarget(root)
    const dead = result.warnings.filter((w) => w.code === 'W430')
    // AGENTS.md + CLAUDE.md (symlink) both dead
    expect(dead.length).toBe(2)
    expect(dead.every((w) => w.severity === 'error')).toBe(true)
  })

  it('does not flag example links inside a code fence as broken pointers (W421)', async () => {
    const skillDir = await writeSkill(
      tempDir,
      'validate-thing',
      'name: validate-thing\ndescription: d',
      [
        '## Example of a good file',
        '```',
        '- [Conventions](docs/AGENTS-typescript.md)',
        '```',
      ].join('\n')
    )
    const ctx = await scanHygieneTarget(skillDir)
    const w = await lintHygiene(ctx)
    expect(w.filter((x) => x.code === 'W421')).toHaveLength(0)
  })

  it('linting a single skill dir reports only that skill, not its siblings', async () => {
    const lonely = await writeSkill(tempDir, 'lonely', 'name: other\ndescription: d', 'Body.')
    await writeSkill(tempDir, 'sibling', 'name: mismatch\ndescription: d', 'Body.')

    const result = await runHygieneTarget(lonely)

    expect(result.context.units.map((unit) => unit.kind)).toEqual(['skill'])
    expect(result.warnings.map((w) => [w.code, w.path])).toEqual([
      ['W400', join(lonely, 'SKILL.md')],
    ])
  })
})

describe('baseline suppression', () => {
  it('suppresses grandfathered findings and keeps new ones', async () => {
    await writeSkill(tempDir, 'foo', 'name: bar\ndescription: d', 'x')
    const grandfathered = await runHygieneTarget(tempDir)
    expect(grandfathered.warnings.map((w) => w.code)).toEqual(['W400'])

    const baselinePath = join(tempDir, '.hygiene-baseline.json')
    await writeBaseline(baselinePath, grandfathered.warnings, tempDir)
    await writeSkill(tempDir, 'baz', 'name: qux\ndescription: d', 'x')

    const result = await runHygieneTarget(tempDir, { baselinePath, baselineRoot: tempDir })

    expect(result.suppressed).toEqual(grandfathered.warnings)
    expect(result.warnings.map((w) => [w.code, w.path])).toEqual([
      ['W400', join(tempDir, 'baz', 'SKILL.md')],
    ])
  })

  it('fingerprint ignores a line-anchor shift', () => {
    const a = fingerprint(
      { code: 'W415', message: 'm', severity: 'info', path: '/x/SKILL.md:5' },
      undefined
    )
    const b = fingerprint(
      { code: 'W415', message: 'm', severity: 'info', path: '/x/SKILL.md:9' },
      undefined
    )
    expect(a).toBe(b)
  })
})

describe('tier-2 judge core', () => {
  it('assembles a prompt embedding tier-1 results and the instrument', () => {
    const unit = skillUnit(tempDir, '---\nname: x\n---\nBody.', { name: 'x', description: 'd' })
    const { system, user } = buildJudgePrompt(
      unit,
      [{ code: 'W400', message: 'name mismatch', severity: 'warning', path: unit.path }],
      'RUBRIC TEXT HERE'
    )
    expect(system).toContain('RUBRIC TEXT HERE')
    expect(user).toContain('W400')
    expect(user).toContain('Body.')
  })

  it('validates a well-formed scorecard and rejects a malformed one', () => {
    const good: Scorecard = {
      unit: 'x',
      classification: { invocation_mode: 'model-invoked', load_frequency: 'on-demand' },
      score_pct: 80,
      grade: 'Good',
      critical_gate: { passed: true },
      criteria: [{ id: 'U1', weight: 1, verdict: 'pass', score: 1 }],
    }
    expect(validateScorecard(good).valid).toBe(true)

    const bad = { unit: 'x', criteria: 'not-an-array' }
    const res = validateScorecard(bad)
    expect(res.valid).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
  })
})
