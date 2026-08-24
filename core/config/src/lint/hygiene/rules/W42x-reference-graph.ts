/**
 * W420-W422: skill reference-graph checks (rubric §2 M5; U21/BP-58, U13/BP-11, U14/BP-12).
 *
 *  - W420 orphaned/dev-scaffolding artifact bundled in the runtime dir.
 *  - W421 markdown link to a file that does not exist (broken pointer).
 *  - W422 reference file >100 lines with no top-of-file Contents list.
 *
 * Asymmetric precision: W421 (broken pointer, `error`) fires only on real markdown
 * link syntax `[..](path)` so it never false-positives on prose filename mentions;
 * W420 (orphan, `warning`) treats ANY bare filename mention as "reachable" so it
 * under-reports rather than nagging on live files.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { LintWarning } from '../../types.js'
import { lineCount } from '../parse.js'
import type { HygieneContext, HygieneUnit } from '../types.js'
import { HYGIENE_CODES } from '../types.js'

const REFERENCE_EXT = /\.(md|sh|js|ts|py|mjs|cjs|json|txt)$/
const DEV_ARTIFACT = /^(CREATION-LOG|CHANGELOG|RED-BASELINE)|(^|[.-])(test|eval|scratch|tmp)/i

/** All files under a skill dir (recursive), as paths relative to the dir. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await listFiles(join(dir, entry.name), rel)))
    } else {
      out.push(rel)
    }
  }
  return out
}

/**
 * Remove fenced code blocks so example links/paths inside ``` fences are not
 * treated as real pointers (W421 is an error and gates --strict — a skill that
 * documents what a good AGENTS.md looks like must not fail on its own examples).
 */
function stripFences(content: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) {
      out.push(line)
    }
  }
  return out.join('\n')
}

/** Markdown-link targets `[text](path)` that look like local files (fences stripped). */
function linkTargets(content: string): string[] {
  const targets: string[] = []
  for (const m of stripFences(content).matchAll(/\]\(([^)]+)\)/g)) {
    const raw = (m[1] ?? '').trim().split(/\s+/)[0] ?? ''
    if (raw === '' || /^[a-z]+:\/\//i.test(raw) || raw.startsWith('#') || raw.startsWith('/')) {
      continue
    }
    targets.push(raw.replace(/#.*$/, ''))
  }
  return targets
}

/** Any bare filename mention with a reference extension (lenient reach set). */
function mentionedFiles(content: string): Set<string> {
  const set = new Set<string>()
  for (const m of content.matchAll(/[A-Za-z0-9_./-]+\.(md|sh|js|ts|py|mjs|cjs|json|txt)\b/g)) {
    set.add(basename(m[0]))
  }
  return set
}

async function checkSkill(unit: HygieneUnit): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []
  const files = await listFiles(unit.dir)
  const referenceFiles = files.filter((f) => REFERENCE_EXT.test(f) && basename(f) !== 'SKILL.md')

  const mentioned = mentionedFiles(unit.content)
  const links = linkTargets(unit.content)

  // W421 — broken markdown-link pointers.
  for (const target of links) {
    const resolved = join(unit.dir, target)
    let exists = false
    try {
      await stat(resolved)
      exists = true
    } catch {
      exists = false
    }
    if (!exists) {
      warnings.push({
        code: HYGIENE_CODES.BROKEN_POINTER,
        message: `Broken pointer: SKILL.md links '${target}' which does not exist. Fix the link, create the target, or drop the dangling pointer.`,
        severity: 'error',
        path: unit.path,
        details: { unit: unit.key, target },
      })
    }
  }

  // W420 — orphaned / dev-scaffolding artifacts.
  for (const file of referenceFiles) {
    const base = basename(file)
    const reachable = mentioned.has(base) || links.some((t) => basename(t) === base)
    const isDevArtifact = DEV_ARTIFACT.test(base)
    if (isDevArtifact) {
      warnings.push({
        code: HYGIENE_CODES.ORPHANED_FILE,
        message: `Dev/test/log artifact '${file}' ships in the runtime skill dir (BP-58). Move it to the pack root or delete it.`,
        severity: 'warning',
        path: join(unit.dir, file),
        details: { unit: unit.key, file },
      })
    } else if (!reachable) {
      warnings.push({
        code: HYGIENE_CODES.ORPHANED_FILE,
        message: `Bundled file '${file}' is reached by no pointer in SKILL.md (BP-58). Add a pointer if live, or delete it.`,
        severity: 'warning',
        path: join(unit.dir, file),
        details: { unit: unit.key, file },
      })
    }
  }

  // W422 — reference file >100 lines with no top-of-file Contents list.
  for (const file of referenceFiles) {
    if (!file.endsWith('.md')) {
      continue
    }
    let content: string
    try {
      content = await readFile(join(unit.dir, file), 'utf-8')
    } catch {
      continue
    }
    const lines = lineCount(content)
    if (lines <= 100) {
      continue
    }
    const head = content.split(/\r?\n/).slice(0, 15).join('\n')
    if (!/\b(contents|table of contents|toc)\b/i.test(head)) {
      warnings.push({
        code: HYGIENE_CODES.REFERENCE_NESTING,
        message: `Reference file '${file}' is ${lines} lines with no top-of-file Contents list (BP-12). Add a TOC.`,
        severity: 'info',
        path: join(unit.dir, file),
        details: { unit: unit.key, file, lines },
      })
    }
  }

  return warnings
}

export async function checkReferenceGraph(ctx: HygieneContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []
  for (const unit of ctx.units) {
    if (unit.kind !== 'skill') {
      continue
    }
    warnings.push(...(await checkSkill(unit)))
  }
  return warnings
}
