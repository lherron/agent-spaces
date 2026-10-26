/**
 * The aspd compare runner's volatile mask (T-11833): the ONLY inputs it may
 * tokenize before diffing two subjects. Every entry was measured, never
 * guessed: it differs between two runs of the same Bun aspd release at
 * identical paths with nothing pinned (`run.ts --raw`; evidence
 * var/wrkq-artifacts/T-11833/measure-2/{report.json,a-stage,b-stage}). Nothing
 * outside the measured set may be added. Derived hashes are never masked here:
 * the runner re-derives plan hashes per subject and checks fingerprint
 * consistency per subject before it tokenizes their values.
 */

/** A reply field replaced by `«token»` (path uses `*` for one key or index). */
export type ResponseMask = { path: string; token: string; measured: string }

/** A value found in a subject's replies and tokenized wherever it occurs. */
export type Token = { token: string; measured: string; find: (replies: unknown[]) => string[] }

/** A content pattern (global regex) replaced in matching stage files before hashing. */
export type TreeMask = { path: RegExp; content: RegExp; token: string; measured: string }

const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`
const stamp = (field: string) => new RegExp(`"${field}": "${ISO}"`, 'g')

export const RESPONSE_MASK: ResponseMask[] = [
  {
    path: 'reply.result.plan.createdAt',
    token: 'wall-clock',
    measured: 'every compile case: compile time (not plan-hash material)',
  },
  {
    path: 'reply.result.evaluatedAt',
    token: 'wall-clock',
    measured: 'every ok resolveRuntimeDeclaration case: evaluation time',
  },
]

function sessionIds(value: unknown, out: string[]): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item === '--session-id' && typeof value[index + 1] === 'string') {
        out.push(value[index + 1] as string)
      }
      sessionIds(item, out)
    })
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) sessionIds(item, out)
  }
  return out
}

export const TOKENS: Token[] = [
  {
    token: 'claude-session-id',
    measured:
      'compile:claude-code and compile:claude-code:summon-model: a fresh `--session-id <randomUUID()>` in the launch args (claude-adapter.ts); claude-code-resume has none and is stable',
    find: (replies) => sessionIds(replies, []),
  },
]

export const TREE_MASK: TreeMask[] = [
  {
    path: /^asp-home\/(cache\/[0-9a-f]{64}|codex-homes\/.*\/plugins\/[^/]+)\/\.asp-cache\.json$/,
    content: stamp('createdAt'),
    token: 'wall-clock',
    measured: 'plugin cache metadata createdAt',
  },
  {
    path: /^asp-home\/codex-homes\/.*\/\.asp-materialized\.json$/,
    content: stamp('generatedAt'),
    token: 'wall-clock',
    measured: 'bundle materialization generatedAt (claude, codex, muse)',
  },
  {
    path: /^asp-home\/codex-homes\/[^/]+\/(bundles\/\.versions\/.*\/codex\.home\/)?manifest\.json$/,
    content: stamp('generatedAt'),
    token: 'wall-clock',
    measured: 'codex home manifest generatedAt (bundle template and runtime home)',
  },
  {
    path: /\/muse\.home\/muse-serve-metadata\.json$/,
    content: stamp('createdAt'),
    token: 'wall-clock',
    measured: 'muse serve metadata createdAt',
  },
  {
    path: /^asp-home\/snapshots\/[0-9a-f]{64}\/\.asp-snapshot\.json$/,
    content: stamp('createdAt'),
    token: 'wall-clock',
    measured: 'snapshot metadata createdAt',
  },
  {
    path: /^asp-home\/global-lock\.json$/,
    content: stamp('generatedAt'),
    token: 'wall-clock',
    measured: 'global lock generatedAt',
  },
  {
    path: /^asp-home\/codex-homes\/[^/]+\/(bundles\/\.versions\/.*\/codex\.home\/)?config\.toml$/,
    content: /tmp\/\.staging\/bundle-[A-Za-z0-9._-]+-[0-9a-f]{16}-\d+-[0-9a-f-]{36}\//g,
    token: 'bundle-staging-dir',
    measured:
      'codex config.toml `[hooks.state."<staging dir>/…/hooks.json:stop:0:0"]` key: the per-process bundle staging dir (pid + uuid), T-11825 stale hooks.state defect',
  },
]
