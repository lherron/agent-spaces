import { readFile, readdir } from 'node:fs/promises'
import { basename, extname, relative, sep } from 'node:path'

const ignoredDirectoryNames = new Set([
  '.git',
  'asp_modules',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
])

const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const testDirectoryNames = new Set(['__tests__', 'integration-tests', 'test', 'tests'])

const forbiddenPatterns = [
  /\bgit\s+clone(?:\s|["'`])/giu,
  /\bgit\s*\([^)]{0,500}["'`]clone["'`]/gisu,
  /(?:Bun\.)?spawn(?:Sync)?\s*\(\s*\[\s*["'`]git["'`]\s*,\s*["'`]clone["'`]/gisu,
  /execFile(?:Sync)?\s*\(\s*["'`]git["'`]\s*,\s*\[\s*["'`]clone["'`]/gisu,
]

export interface TestCloneFinding {
  path: string
  line: number
}

function normalizedParts(path: string): string[] {
  return path.split(/[\\/]+/u).filter(Boolean)
}

export function isTestExecutionPath(path: string): boolean {
  const normalized = path.split(sep).join('/')
  const parts = normalizedParts(normalized)
  const file = basename(normalized)

  return (
    testFilePattern.test(file) ||
    parts.some((part) => testDirectoryNames.has(part)) ||
    normalized.startsWith('scripts/test-') ||
    normalized === 'scripts/run-tests-no-git-clone.ts' ||
    normalized === 'lefthook.yml' ||
    file === 'package.json'
  )
}

function lineForOffset(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function forbiddenOffsets(source: string): number[] {
  const offsets = new Set<number>()
  for (const pattern of forbiddenPatterns) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      offsets.add(match.index)
    }
  }
  return [...offsets]
}

function packageTestScriptFindings(path: string, source: string): TestCloneFinding[] {
  let manifest: { scripts?: Record<string, unknown> }
  try {
    manifest = JSON.parse(source) as { scripts?: Record<string, unknown> }
  } catch {
    return []
  }

  const lines = new Set<number>()
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (!/^(?:check|smoke|test)(?::|$)/u.test(name) || typeof command !== 'string') continue
    if (forbiddenOffsets(command).length === 0) continue
    const keyOffset = source.indexOf(JSON.stringify(name))
    lines.add(lineForOffset(source, Math.max(0, keyOffset)))
  }

  return [...lines].sort((left, right) => left - right).map((line) => ({ path, line }))
}

export function findForbiddenTestCloneCommands(path: string, source: string): TestCloneFinding[] {
  if (!isTestExecutionPath(path)) return []
  if (basename(path) === 'package.json') return packageTestScriptFindings(path, source)

  return forbiddenOffsets(source)
    .map((offset) => lineForOffset(source, offset))
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .sort((left, right) => left - right)
    .map((line) => ({ path, line }))
}

async function collectFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, path)))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }

  return files
}

export async function scanTestCloneCommands(root: string): Promise<TestCloneFinding[]> {
  const files = await collectFiles(root)
  const findings: TestCloneFinding[] = []

  for (const absolutePath of files) {
    const path = relative(root, absolutePath).split(sep).join('/')
    if (!isTestExecutionPath(path)) continue
    if (
      !['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sh', '.yml', '.yaml'].includes(
        extname(path)
      )
    ) {
      continue
    }
    const source = await readFile(absolutePath, 'utf8')
    findings.push(...findForbiddenTestCloneCommands(path, source))
  }

  return findings
}
