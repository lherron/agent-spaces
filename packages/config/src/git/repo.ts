import { gitExec, gitExecLines, gitExecStdout } from './exec.js'

/**
 * Repository status information.
 */
export interface RepoStatus {
  /** Whether the repository is clean (no uncommitted changes) */
  clean: boolean
  /** Current branch name */
  branch: string | null
  /** Current HEAD commit SHA */
  head: string
  /** Number of commits ahead of upstream */
  ahead: number
  /** Number of commits behind upstream */
  behind: number
  /** List of modified files */
  modified: string[]
  /** List of untracked files */
  untracked: string[]
  /** List of staged files */
  staged: string[]
}

/**
 * Remote information.
 */
export interface RemoteInfo {
  /** Remote name (e.g., "origin") */
  name: string
  /** Fetch URL */
  fetchUrl: string
  /** Push URL (usually same as fetch) */
  pushUrl: string
}

/**
 * Check if a directory is a git repository.
 *
 * @param path - Directory path to check
 * @returns True if path is inside a git repository
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const result = await gitExec(['rev-parse', '--git-dir'], {
    cwd: path,
    ignoreExitCode: true,
  })
  return result.exitCode === 0
}

/**
 * Check if a directory is the root of a git repository.
 *
 * @param path - Directory path to check
 * @returns True if path is the repository root
 */
export async function isRepoRoot(path: string): Promise<boolean> {
  try {
    const root = await gitExecStdout(['rev-parse', '--show-toplevel'], {
      cwd: path,
    })
    // Normalize paths for comparison
    const normalizedPath = path.replace(/\/+$/, '')
    const normalizedRoot = root.replace(/\/+$/, '')
    return normalizedPath === normalizedRoot
  } catch {
    return false
  }
}

/**
 * Get the root directory of a git repository.
 *
 * @param path - Any path within the repository
 * @returns Absolute path to repository root
 * @throws GitError if not in a git repository
 */
export async function getRepoRoot(path: string): Promise<string> {
  return gitExecStdout(['rev-parse', '--show-toplevel'], { cwd: path })
}

/**
 * Initialize a new git repository.
 *
 * @param path - Directory path to initialize
 * @param options - Additional options
 * @throws GitError if initialization fails
 *
 * @example
 * ```typescript
 * await initRepo('/path/to/new/repo');
 * await initRepo('/path/to/bare', { bare: true });
 * ```
 */
export async function initRepo(
  path: string,
  options: {
    bare?: boolean | undefined
    initialBranch?: string | undefined
  } = {}
): Promise<void> {
  const args = ['init']

  if (options.bare) {
    args.push('--bare')
  }

  if (options.initialBranch) {
    args.push('-b', options.initialBranch)
  }

  args.push(path)

  await gitExec(args)
}

/**
 * Clone a git repository.
 *
 * @param url - Repository URL to clone
 * @param destPath - Destination directory
 * @param options - Clone options
 * @throws GitError if clone fails
 *
 * @example
 * ```typescript
 * await cloneRepo('https://github.com/user/repo.git', '/path/to/dest');
 * await cloneRepo('git@github.com:user/repo.git', '/path/to/dest', { branch: 'main' });
 * ```
 */
export async function cloneRepo(
  url: string,
  destPath: string,
  options: {
    branch?: string | undefined
    depth?: number | undefined
    bare?: boolean | undefined
  } = {}
): Promise<void> {
  const args = ['clone']

  if (options.branch) {
    args.push('-b', options.branch)
  }

  if (options.depth !== undefined) {
    args.push('--depth', String(options.depth))
  }

  if (options.bare) {
    args.push('--bare')
  }

  args.push(url, destPath)

  await gitExec(args, { timeout: 300000 }) // 5 minute timeout for clone
}

/**
 * Fetch from a remote repository.
 *
 * @param remote - Remote name (defaults to "origin")
 * @param options - Fetch options including cwd
 * @throws GitError if fetch fails
 */
export async function fetch(
  remote = 'origin',
  options: {
    cwd?: string | undefined
    prune?: boolean | undefined
    tags?: boolean | undefined
    all?: boolean | undefined
  } = {}
): Promise<void> {
  const args = ['fetch']

  if (options.all) {
    args.push('--all')
  } else {
    args.push(remote)
  }

  if (options.prune) {
    args.push('--prune')
  }

  if (options.tags) {
    args.push('--tags')
  }

  await gitExec(args, { cwd: options.cwd, timeout: 120000 }) // 2 minute timeout
}

/**
 * Pull from a remote repository.
 *
 * @param remote - Remote name (defaults to "origin")
 * @param branch - Branch name (defaults to current branch)
 * @param options - Pull options including cwd
 * @throws GitError if pull fails
 */
export async function pull(
  remote = 'origin',
  branch?: string | undefined,
  options: {
    cwd?: string | undefined
    rebase?: boolean | undefined
  } = {}
): Promise<void> {
  const args = ['pull']

  if (options.rebase) {
    args.push('--rebase')
  }

  args.push(remote)

  if (branch) {
    args.push(branch)
  }

  await gitExec(args, { cwd: options.cwd, timeout: 120000 })
}

/**
 * Get the current branch name.
 *
 * @param options - Options including cwd
 * @returns Branch name, or null if in detached HEAD state
 */
export async function getCurrentBranch(
  options: { cwd?: string | undefined } = {}
): Promise<string | null> {
  const result = await gitExec(['symbolic-ref', '--short', 'HEAD'], {
    ...options,
    ignoreExitCode: true,
  })

  if (result.exitCode !== 0) {
    // Detached HEAD state
    return null
  }

  return result.stdout.trim()
}

/**
 * Get the current HEAD commit SHA.
 *
 * @param options - Options including cwd
 * @returns Full commit SHA
 * @throws GitError if not in a git repository
 */
export async function getHead(options: { cwd?: string | undefined } = {}): Promise<string> {
  return gitExecStdout(['rev-parse', 'HEAD'], options)
}

/**
 * Get the short form of a commit SHA.
 *
 * @param commitish - Full commit SHA or reference
 * @param options - Options including cwd
 * @returns Short (7 char) commit SHA
 */
export async function getShortSha(
  commitish: string,
  options: { cwd?: string | undefined } = {}
): Promise<string> {
  return gitExecStdout(['rev-parse', '--short', commitish], options)
}

// ============================================================================
// Status Parsing Helpers
// ============================================================================

/**
 * Parsed branch information from git status.
 */
interface BranchInfo {
  branch: string | null
  ahead: number
  behind: number
}

/**
 * Parse the branch line from git status --porcelain -b output.
 * Format: ## branch...origin/branch [ahead N, behind M]
 */
function parseBranchLine(line: string): BranchInfo {
  const result: BranchInfo = { branch: null, ahead: 0, behind: 0 }

  const branchMatch = line.match(/^## ([^.]+)/)
  if (branchMatch?.[1]) {
    result.branch = branchMatch[1] === 'HEAD (no branch)' ? null : branchMatch[1]
  }

  const aheadMatch = line.match(/ahead (\d+)/)
  if (aheadMatch?.[1]) {
    result.ahead = Number.parseInt(aheadMatch[1], 10)
  }

  const behindMatch = line.match(/behind (\d+)/)
  if (behindMatch?.[1]) {
    result.behind = Number.parseInt(behindMatch[1], 10)
  }

  return result
}

/**
 * Parsed file status from git status.
 */
interface FileStatusResult {
  modified: string[]
  untracked: string[]
  staged: string[]
}

/**
 * Categorize a single file by its status codes.
 */
function categorizeFile(
  indexStatus: string,
  workTreeStatus: string,
  filePath: string,
  result: FileStatusResult
): void {
  if (workTreeStatus === '?' || indexStatus === '?') {
    result.untracked.push(filePath)
    return
  }
  if (indexStatus !== ' ' && indexStatus !== '?') {
    result.staged.push(filePath)
  }
  if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
    result.modified.push(filePath)
  }
}

/**
 * Parse file status lines from git status --porcelain output.
 * Each line has format: XY filename
 * where X is index status and Y is worktree status.
 */
function parseStatusLines(lines: string[]): FileStatusResult {
  const result: FileStatusResult = { modified: [], untracked: [], staged: [] }

  for (const line of lines) {
    // Skip branch line and lines too short
    if (line.startsWith('##') || line.length < 3) continue

    // Use charAt which always returns a string (empty string for out of bounds)
    const indexStatus = line.charAt(0)
    const workTreeStatus = line.charAt(1)
    const filePath = line.slice(3)
    categorizeFile(indexStatus, workTreeStatus, filePath, result)
  }

  return result
}

/**
 * Get repository status.
 *
 * @param options - Options including cwd
 * @returns Detailed status information
 */
export async function getStatus(options: { cwd?: string | undefined } = {}): Promise<RepoStatus> {
  // Get porcelain status
  const statusLines = await gitExecLines(['status', '--porcelain', '-b'], options)

  // Find and parse the branch line
  const branchLine = statusLines.find((line) => line.startsWith('##'))
  const branchInfo = branchLine
    ? parseBranchLine(branchLine)
    : { branch: null, ahead: 0, behind: 0 }

  // Parse file status lines
  const fileStatus = parseStatusLines(statusLines)

  const head = await getHead(options)
  const clean =
    fileStatus.modified.length === 0 &&
    fileStatus.untracked.length === 0 &&
    fileStatus.staged.length === 0

  return {
    clean,
    branch: branchInfo.branch,
    head,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    modified: fileStatus.modified,
    untracked: fileStatus.untracked,
    staged: fileStatus.staged,
  }
}

/**
 * List remotes.
 *
 * @param options - Options including cwd
 * @returns Array of remote information
 */
export async function listRemotes(
  options: { cwd?: string | undefined } = {}
): Promise<RemoteInfo[]> {
  const lines = await gitExecLines(['remote', '-v'], options)

  const remotes = new Map<string, RemoteInfo>()

  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (match) {
      const name = match[1] ?? ''
      const url = match[2] ?? ''
      const type = match[3]
      let info = remotes.get(name)
      if (!info) {
        info = { name, fetchUrl: '', pushUrl: '' }
        remotes.set(name, info)
      }
      if (type === 'fetch') {
        info.fetchUrl = url
      } else {
        info.pushUrl = url
      }
    }
  }

  return Array.from(remotes.values())
}

/**
 * Add a remote.
 *
 * @param name - Remote name
 * @param url - Remote URL
 * @param options - Options including cwd
 * @throws GitError if remote already exists
 */
export async function addRemote(
  name: string,
  url: string,
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  await gitExec(['remote', 'add', name, url], options)
}

/**
 * Remove a remote.
 *
 * @param name - Remote name
 * @param options - Options including cwd
 * @throws GitError if remote doesn't exist
 */
export async function removeRemote(
  name: string,
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  await gitExec(['remote', 'remove', name], options)
}

/**
 * Set the URL for a remote.
 *
 * @param name - Remote name
 * @param url - New URL
 * @param options - Options including cwd
 */
export async function setRemoteUrl(
  name: string,
  url: string,
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  await gitExec(['remote', 'set-url', name, url], options)
}

/**
 * Get the default branch name for a remote.
 *
 * @param remote - Remote name (defaults to "origin")
 * @param options - Options including cwd
 * @returns Default branch name (e.g., "main" or "master")
 */
export async function getDefaultBranch(
  remote = 'origin',
  options: { cwd?: string | undefined } = {}
): Promise<string> {
  // First try to get from remote HEAD
  const result = await gitExec(['symbolic-ref', `refs/remotes/${remote}/HEAD`], {
    ...options,
    ignoreExitCode: true,
  })

  if (result.exitCode === 0) {
    // refs/remotes/origin/HEAD -> refs/remotes/origin/main
    const ref = result.stdout.trim()
    return ref.replace(`refs/remotes/${remote}/`, '')
  }

  // Fallback: check for common default branch names
  for (const branch of ['main', 'master']) {
    const checkResult = await gitExec(
      ['show-ref', '--verify', `refs/remotes/${remote}/${branch}`],
      { ...options, ignoreExitCode: true }
    )
    if (checkResult.exitCode === 0) {
      return branch
    }
  }

  // Last resort: return "main"
  return 'main'
}

/**
 * Checkout a branch or commit.
 *
 * @param target - Branch name or commit SHA
 * @param options - Checkout options
 */
export async function checkout(
  target: string,
  options: {
    cwd?: string | undefined
    create?: boolean | undefined
  } = {}
): Promise<void> {
  const args = ['checkout']

  if (options.create) {
    args.push('-b')
  }

  args.push(target)

  await gitExec(args, { cwd: options.cwd })
}

/**
 * Create a new commit with staged changes.
 *
 * @param message - Commit message
 * @param options - Commit options
 * @returns Commit SHA of the new commit
 */
export async function commit(
  message: string,
  options: {
    cwd?: string | undefined
    allowEmpty?: boolean | undefined
  } = {}
): Promise<string> {
  const args = ['commit', '-m', message]

  if (options.allowEmpty) {
    args.push('--allow-empty')
  }

  await gitExec(args, { cwd: options.cwd })

  return getHead({ cwd: options.cwd })
}

/**
 * Stage files for commit.
 *
 * @param paths - File paths to stage (use "." for all)
 * @param options - Options including cwd
 */
export async function add(
  paths: string[],
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  await gitExec(['add', ...paths], options)
}

/**
 * Push to a remote.
 *
 * @param remote - Remote name
 * @param branch - Branch name
 * @param options - Push options
 */
export async function push(
  remote = 'origin',
  branch?: string | undefined,
  options: {
    cwd?: string | undefined
    setUpstream?: boolean | undefined
    force?: boolean | undefined
  } = {}
): Promise<void> {
  const args = ['push']

  if (options.setUpstream) {
    args.push('-u')
  }

  if (options.force) {
    args.push('--force')
  }

  args.push(remote)

  if (branch) {
    args.push(branch)
  }

  await gitExec(args, { cwd: options.cwd, timeout: 120000 })
}
