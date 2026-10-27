import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

// The wrkf check hook as hook-catalog.json wires it: `bun scripts/closeout-evidence-coverage.ts`
// run from the template dir with the check context as JSON on stdin; the verdict is the exit code
// and, on failure, a JSON diagnostic on stderr.
const TEMPLATE_DIR = join(import.meta.dir, '..')

function runCloseoutCheck(context: unknown): { exitCode: number; stderr: string } {
  const result = Bun.spawnSync(['bun', 'scripts/closeout-evidence-coverage.ts'], {
    cwd: TEMPLATE_DIR,
    stdin: new TextEncoder().encode(JSON.stringify(context)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { exitCode: result.exitCode, stderr: result.stderr.toString() }
}

describe('closeout evidence coverage hook', () => {
  test.each([
    {
      name: 'a docs-only change under a docs claim requires docs coverage',
      claimClass: 'docs',
      files: ['docs/closeout-evidence.md'],
      requiredSurface: 'docs',
      expectedKind: 'docs_reachability',
    },
    {
      name: 'a harness path under a docs claim escalates the requirement to harness',
      claimClass: 'docs',
      files: ['harness/harness-broker/src/core.ts'],
      requiredSurface: 'harness',
      expectedKind: 'matrix',
    },
    {
      name: 'an unmatched path keeps the claim surface as the floor',
      claimClass: 'contract',
      files: ['unmapped/private.file'],
      requiredSurface: 'contract',
      expectedKind: 'contract',
    },
  ])(
    '$name, and rejects a closeout with no covering evidence',
    ({ claimClass, files, requiredSurface, expectedKind }) => {
      const { exitCode, stderr } = runCloseoutCheck({
        evidence: [
          { kind: 'closeout_claim', facts: { claimClass } },
          { kind: 'changed_files', data: { files } },
        ],
      })

      expect(exitCode).toBe(1)
      expect(JSON.parse(stderr.trim())).toMatchObject({
        requiredSurface,
        recordedDiffFloor: requiredSurface,
        expectedKind,
        foundKind: null,
        reason: 'missing covering evidence for required surface',
      })
    }
  )
})
