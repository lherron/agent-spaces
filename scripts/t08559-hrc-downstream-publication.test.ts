import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const JUSTFILE = join(import.meta.dir, '..', 'justfile')

describe('T-08559 ASP downstream handoff', () => {
  test('updates HRC dependencies without publishing HRC from an ASP install', () => {
    const content = readFileSync(JUSTFILE, 'utf8')
    const hrcSyncLines = content
      .split('\n')
      .filter((line) => line.includes('sync-hrc-downstream.sh'))

    expect(hrcSyncLines).toEqual([
      '        bash "$repo_root/scripts/sync-hrc-downstream.sh" "$hrc_runtime" 2>&1 | sed \'s/^/[hrc-sync] /\'',
      '      bash "$repo_root/scripts/sync-hrc-downstream.sh" "$hrc_runtime" 2>&1 | sed \'s/^/[hrc-sync] /\'',
    ])
    expect(content).toContain(
      'HRC release remains local until its owner runs `just install` and `just publish`.'
    )
  })
})
