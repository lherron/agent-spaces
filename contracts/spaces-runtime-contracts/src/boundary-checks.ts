export type BoundaryCheck = {
  id: string
  description: string
  command: string
  severity: 'warning' | 'error'
  allowedPaths?: string[] | undefined
}

// NOTE: each `command` below is a single ripgrep invocation whose source text is
// DELIBERATELY split mid-token via string concatenation (e.g. `packages/hrc-` +
// `server/src`, `spaces-harness-` + `codex`, and the patterns inside the `rg`
// regex). The split keeps THIS file from matching the very boundary patterns it
// ships — these checks scan the repo for those literals, and an un-split literal
// here would self-trigger. The concatenated result is the real command and must
// stay byte-identical when edited; do not "tidy" the literals back together or a
// stray space/reorder will silently change the executed `rg` pattern/path.
export const REQUIRED_BOUNDARY_CHECKS: BoundaryCheck[] = [
  {
    id: 'no-nonlegacy-exec-ts',
    description: 'No broker-capable HRC path may invoke launch/exec.ts.',
    // Concatenates to: rg "launch/exec|exec\.ts" packages/hrc-server/src …
    command:
      'rg "launch/exec|exec\\.ts" packages/hrc-' +
      "server/src -g '!**/runtime-controllers/legacy-exec/**' -g '!**/__tests__/legacy-exec/**'",
    severity: 'error',
  },
  {
    id: 'no-hrc-driver-internals',
    description: 'HRC broker paths must not import concrete harness driver internals.',
    // Concatenates to: rg "spaces-harness-codex|…|harness-broker/src/drivers" packages/hrc-* …
    command:
      'rg "spaces-harness-' +
      'codex|runCodexAppServerOneShot|codexAppServer|harness-broker/' +
      "src/drivers\" packages/hrc-* -g '!**/runtime-controllers/legacy-exec/**' -g '!**/__tests__/**'",
    severity: 'error',
  },
  {
    id: 'no-hrc-broker-spec-synthesis',
    description: 'HRC broker paths must not synthesize or mutate broker execution mechanics.',
    // Concatenates to: rg "InvocationStartRequest…|driver:" packages/hrc-server/src …
    command:
      'rg "InvocationStartRequest\\s*=|HarnessInvocationSpec\\s*=|spec\\.driver|spec\\.process|process\\.args|process\\.lockedEnv|process\\.cwd|driver:" packages/hrc-' +
      "server/src -g '!**/runtime-controllers/legacy-exec/**' -g '!**/__tests__/**'",
    severity: 'error',
  },
]
