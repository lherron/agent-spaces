/**
 * spaces-git - Git operations wrapper
 *
 * This package provides a safe, typed interface to git operations
 * using direct subprocess execution (no shell interpolation).
 *
 * Key design decisions:
 * - Shell out to system git (simpler than isomorphic-git)
 * - Use argv arrays for safety (prevents command injection)
 * - Expose both low-level exec and high-level operations
 */

// Core execution
export {
  gitExec,
  gitExecStdout,
  gitExecLines,
  type GitExecResult,
  type GitExecOptions,
} from './exec.js'

// Tag operations
export {
  listTags,
  listTagsWithCommits,
  getTagCommit,
  tagExists,
  createTag,
  createAnnotatedTag,
  deleteTag,
  pushTag,
  deleteRemoteTag,
  fetchTags,
  type GitTag,
} from './tags.js'

// File content operations
export {
  showFile,
  showFileOrNull,
  fileExistsAtCommit,
  getObjectType,
  showJson,
  showJsonOrNull,
} from './show.js'

// Tree operations
export {
  listTree,
  listTreeRecursive,
  listTreeRecursiveWithDirs,
  filterTreeEntries,
  getBlobContent,
  parseMode,
  type TreeEntry,
  type ParsedMode,
} from './tree.js'

// Archive operations
export {
  extractTree,
  extractTreeToTemp,
  getArchiveBuffer,
  type ArchiveOptions,
} from './archive.js'

// Repository operations
export {
  isGitRepo,
  isRepoRoot,
  getRepoRoot,
  initRepo,
  cloneRepo,
  fetch,
  pull,
  getCurrentBranch,
  getHead,
  getShortSha,
  getStatus,
  listRemotes,
  addRemote,
  removeRemote,
  setRemoteUrl,
  getDefaultBranch,
  checkout,
  commit,
  add,
  push,
  type RepoStatus,
  type RemoteInfo,
} from './repo.js'
