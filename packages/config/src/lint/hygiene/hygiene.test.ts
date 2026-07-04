/**
 * Tests for the two-tier agent-hygiene linter (tier-1 W4xx rules, scan, baseline,
 * and the tier-2 judge core: prompt assembly + scorecard validation).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyBaseline, fingerprint, writeBaseline } from './baseline.js'
import {
  RUBRIC_SCORECARD_SCHEMA,
  type Scorecard,
  buildJudgePrompt,
  validateScorecard,
} from './judge.js'
import { promptRegime, stripFrontmatter, wordCount } from './parse.js'
import { checkTripwires } from './rules/W41x-tripwires.js'
import { checkNameMatchesDir } from './rules/W400-name-dirname.js'
import { checkDeadLayer } from './rules/W430-dead-layer.js'
import { lintHygiene, runHygieneTarget } from './run.js'
import { scanHygieneTarget } from './scan.js'
import type { HygieneContext, HygieneUnit } from './types.js'

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
  it('flags a name mismatch', () => {
    const unit = skillUnit(join(tempDir, 'foo'), '---\nname: bar\n---\nx', {
      name: 'bar',
      description: 'd',
    })
    const ctx: HygieneContext = { units: [unit], agentRoots: [] }
    const w = checkNameMatchesDir(ctx)
    expect(w).toHaveLength(1)
    expect(w[0]?.code).toBe('W400')
  })

  it('passes when name matches and is kebab', () => {
    const unit = skillUnit(join(tempDir, 'foo-bar'), '---\nname: foo-bar\n---\nx', {
      name: 'foo-bar',
      description: 'd',
    })
    expect(checkNameMatchesDir({ units: [unit], agentRoots: [] })).toHaveLength(0)
  })
})

describe('W41x tripwires', () => {
  it('flags model-name weld and human-in-the-loop, skipping fenced code', () => {
    const content = [
      '# skill',
      'Test with Opus and Sonnet here.',
      'Then ask Lance before proceeding.',
      '```',
      'claude-5 in a code fence should be ignored',
      '```',
    ].join('\n')
    const unit = skillUnit(tempDir, content, { name: 'x', description: 'd' })
    const w = checkTripwires({ units: [unit], agentRoots: [] })
    const codes = w.map((x) => x.code)
    expect(codes).toContain('W415')
    expect(codes).toContain('W417')
    // fenced claude-5 must NOT produce a W415 hit on that line
    expect(w.every((x) => !x.path?.endsWith(':5'))).toBe(true)
    // every tripwire is advisory info
    expect(w.every((x) => x.severity === 'info')).toBe(true)
  })
})

describe('W430 dead layer', () => {
  it('flags an agent-root instruction file referenced by no template', () => {
    const unit: HygieneUnit = {
      kind: 'prompt',
      key: 'clod/prompt:AGENTS.md',
      path: join(tempDir, 'clod', 'AGENTS.md'),
      dir: join(tempDir, 'clod'),
      regime: 'resident',
      content: 'my SOP',
      agentId: 'clod',
    }
    const ctx: HygieneContext = {
      units: [unit],
      agentRoots: [
        {
          agentId: 'clod',
          root: join(tempDir, 'clod'),
          referencedFiles: new Set(['SOUL.md', 'AGENT_MOTD.md']),
        },
      ],
    }
    const w = checkDeadLayer(ctx)
    expect(w).toHaveLength(1)
    expect(w[0]?.code).toBe('W430')
    expect(w[0]?.severity).toBe('error')
  })

  it('does not flag when the file is referenced', () => {
    const unit: HygieneUnit = {
      kind: 'prompt',
      key: 'clod/prompt:AGENTS.md',
      path: join(tempDir, 'clod', 'AGENTS.md'),
      dir: join(tempDir, 'clod'),
      regime: 'resident',
      content: 'x',
      agentId: 'clod',
    }
    const ctx: HygieneContext = {
      units: [unit],
      agentRoots: [
        { agentId: 'clod', root: join(tempDir, 'clod'), referencedFiles: new Set(['AGENTS.md']) },
      ],
    }
    expect(checkDeadLayer(ctx)).toHaveLength(0)
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

  it('scanHygieneTarget on a single skill dir yields one unit', async () => {
    const skillDir = await writeSkill(tempDir, 'lonely', 'name: lonely\ndescription: d', 'Body.')
    const ctx = await scanHygieneTarget(skillDir)
    expect(ctx.units).toHaveLength(1)
    expect(ctx.units[0]?.kind).toBe('skill')
  })
})

describe('baseline suppression', () => {
  it('suppresses grandfathered findings and keeps new ones', async () => {
    const unit = skillUnit(join(tempDir, 'foo'), '---\nname: bar\n---\nx', {
      name: 'bar',
      description: 'd',
    })
    const all = await lintHygiene({ units: [unit], agentRoots: [] })
    expect(all.length).toBeGreaterThan(0)

    const baselinePath = join(tempDir, '.hygiene-baseline.json')
    await writeBaseline(baselinePath, all, tempDir)
    const baseline = JSON.parse(await Bun.file(baselinePath).text())
    const { kept, suppressed } = applyBaseline(all, baseline, tempDir)
    expect(kept).toHaveLength(0)
    expect(suppressed.length).toBe(all.length)
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

  it('schema requires the §7 keys', () => {
    expect(RUBRIC_SCORECARD_SCHEMA.required).toContain('critical_gate')
    expect(RUBRIC_SCORECARD_SCHEMA.required).toContain('criteria')
  })
})
