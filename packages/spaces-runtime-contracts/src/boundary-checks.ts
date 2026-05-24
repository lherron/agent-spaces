export type BoundaryCheck = {
  id: string
  description: string
  command: string
  severity: 'warning' | 'error'
  allowedPaths?: string[] | undefined
}

export const REQUIRED_BOUNDARY_CHECKS: BoundaryCheck[] = [
  {
    id: 'no-nonlegacy-exec-ts',
    description: 'No broker-capable HRC path may invoke launch/exec.ts.',
    command:
      'rg "launch/exec|exec\\.ts" packages/hrc-' +
      "server/src -g '!**/runtime-controllers/legacy-exec/**' -g '!**/__tests__/legacy-exec/**'",
    severity: 'error',
  },
  {
    id: 'no-hrc-driver-internals',
    description: 'HRC broker paths must not import concrete harness driver internals.',
    command:
      'rg "spaces-harness-' +
      'codex|runCodexAppServerOneShot|codexAppServer|harness-broker/' +
      "src/drivers\" packages/hrc-* -g '!**/runtime-controllers/legacy-exec/**' -g '!**/__tests__/**'",
    severity: 'error',
  },
  {
    id: 'no-hrc-broker-spec-synthesis',
    description: 'HRC broker paths must not synthesize or mutate broker execution mechanics.',
    command:
      'rg "InvocationStartRequest\\s*=|HarnessInvocationSpec\\s*=|spec\\.driver|spec\\.process|process\\.args|process\\.lockedEnv|process\\.cwd|driver:" packages/hrc-' +
      "server/src -g '!**/runtime-controllers/legacy-exec/**' -g '!**/__tests__/**'",
    severity: 'error',
  },
]
