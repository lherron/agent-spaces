export type BoundaryCheck = {
  id: string
  description: string
  command: string
  severity: 'warning' | 'error'
  allowedPaths?: string[] | undefined
}

// NOTE: each `command` below is a single ripgrep invocation, run from the root
// of an hrc-runtime checkout, whose source text is DELIBERATELY split mid-token
// via string concatenation (e.g. `spaces-harness-` + `codex` and `packages/hrc-`
// + `core/src`). The split keeps THIS file from matching the very boundary
// patterns it ships — these checks scan for those literals, and an un-split
// literal here would self-trigger. The concatenated result is the real command
// and must stay byte-identical when edited; do not "tidy" the literals back
// together or a stray space/reorder will silently change the executed `rg`
// pattern/path.
//
// The paths name hrc-runtime's kept TypeScript packages explicitly, so rg exits
// 2 (a failure, not a vacuous pass) if one of them is removed (T-13147).
export const REQUIRED_BOUNDARY_CHECKS: BoundaryCheck[] = [
  {
    id: 'no-hrc-driver-internals',
    description:
      "hrc-runtime's TypeScript packages must not import concrete harness driver internals.",
    // Concatenates to: rg "spaces-harness-codex|…|harness-broker/src/drivers"
    //   packages/hrc-{core,events,frame-render,sdk,turn-attention}/src …
    command:
      'rg "spaces-harness-' +
      'codex|runCodexAppServerOneShot|harness-broker/' +
      'src/drivers" packages/hrc-' +
      'core/src packages/hrc-' +
      'events/src packages/hrc-' +
      'frame-render/src packages/hrc-' +
      'sdk/src packages/hrc-' +
      "turn-attention/src -g '!**/__tests__/**'",
    severity: 'error',
  },
]
