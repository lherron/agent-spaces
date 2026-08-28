import { extname } from 'node:path'

const documentationExtensions = new Set(['.md', '.markdown', '.html', '.htm', '.txt'])
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export type HookName = 'pre-commit' | 'pre-push'

export interface ChangeScope {
  paths: string[]
  deletionOnlyPush: boolean
  ambiguous: boolean
}

export type ChangeClassification = 'code' | 'documentation' | 'deletion_only' | 'none' | 'ambiguous'

export interface ClassifiedChangeScope {
  kind: ChangeClassification
  fileCount: number
}

function git(cwd: string, args: string[], stdin?: string): Uint8Array {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`git ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout
}

function nulDelimitedPaths(output: Uint8Array): string[] {
  return Buffer.from(output).toString('utf8').split('\0').filter(Boolean)
}

function validOid(value: string): boolean {
  return oidPattern.test(value)
}

function isZeroOid(value: string): boolean {
  return validOid(value) && /^0+$/.test(value)
}

function commitsForUpdate(cwd: string, localOid: string, remoteOid: string): string[] {
  const args = ['rev-list', localOid, '--not']
  if (isZeroOid(remoteOid)) {
    args.push('--remotes')
  } else {
    args.push(remoteOid)
  }
  return Buffer.from(git(cwd, args)).toString('utf8').trim().split('\n').filter(Boolean)
}

function pathsForCommits(cwd: string, commits: string[]): string[] {
  if (commits.length === 0) return []
  return nulDelimitedPaths(
    git(
      cwd,
      [
        'diff-tree',
        '--stdin',
        '--root',
        '--no-commit-id',
        '--name-only',
        '--no-renames',
        '--diff-filter=ACMRD',
        '-m',
        '-r',
        '-z',
      ],
      `${commits.join('\n')}\n`
    )
  )
}

function preCommitScope(cwd: string): ChangeScope {
  return {
    paths: nulDelimitedPaths(
      git(cwd, ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRD', '-z'])
    ),
    deletionOnlyPush: false,
    ambiguous: false,
  }
}

function prePushScope(cwd: string, input: string): ChangeScope {
  const lines = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { paths: [], deletionOnlyPush: false, ambiguous: true }

  const paths = new Set<string>()
  let sawUpdate = false
  let sawNonDeletion = false

  for (const line of lines) {
    const fields = line.split(/\s+/)
    if (fields.length !== 4) return { paths: [], deletionOnlyPush: false, ambiguous: true }
    const [localRef, localOid, remoteRef, remoteOid] = fields as [string, string, string, string]
    if (!validOid(localOid) || !validOid(remoteOid) || !remoteRef.startsWith('refs/')) {
      return { paths: [], deletionOnlyPush: false, ambiguous: true }
    }

    sawUpdate = true
    if (localRef === '(delete)' && isZeroOid(localOid) && !isZeroOid(remoteOid)) continue
    if (!localRef.startsWith('refs/') || isZeroOid(localOid)) {
      return { paths: [], deletionOnlyPush: false, ambiguous: true }
    }

    sawNonDeletion = true
    for (const path of pathsForCommits(cwd, commitsForUpdate(cwd, localOid, remoteOid))) {
      paths.add(path)
    }
  }

  return {
    paths: [...paths],
    deletionOnlyPush: sawUpdate && !sawNonDeletion,
    ambiguous: !sawUpdate,
  }
}

export function isDocumentation(path: string): boolean {
  return documentationExtensions.has(extname(path).toLowerCase())
}

export function classifyChangeScope(scope: ChangeScope): ClassifiedChangeScope {
  if (scope.deletionOnlyPush) return { kind: 'deletion_only', fileCount: scope.paths.length }
  if (scope.ambiguous) return { kind: 'ambiguous', fileCount: scope.paths.length }
  if (scope.paths.length === 0) return { kind: 'none', fileCount: 0 }
  if (scope.paths.every(isDocumentation)) {
    return { kind: 'documentation', fileCount: scope.paths.length }
  }
  return { kind: 'code', fileCount: scope.paths.length }
}

export function shouldSkipCodeValidation(scope: ChangeScope): boolean {
  return scope.deletionOnlyPush || (scope.paths.length > 0 && scope.paths.every(isDocumentation))
}

export function inspectChangeScope(
  hook: HookName,
  options: { cwd?: string; prePushInput?: string } = {}
): ChangeScope {
  const cwd = options.cwd ?? process.cwd()
  return hook === 'pre-commit' ? preCommitScope(cwd) : prePushScope(cwd, options.prePushInput ?? '')
}

export function failSafeChangeScope(error: unknown): ChangeScope {
  console.error(`[hook-scope] unable to inspect changes; running validation: ${error}`)
  return { paths: [], deletionOnlyPush: false, ambiguous: true }
}
