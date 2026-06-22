import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RUNTIME_STATE_STATUS_VALUES,
  RUNTIME_STATUS_VALUES,
  isRuntimeStateStatus,
  isRuntimeStatus,
} from '../src/index.ts'

const ASP_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const HRC_REPO_ROOT = resolve(ASP_REPO_ROOT, '..', 'hrc-runtime')

const EXPECTED_HRC_RUNTIME_STATE_JSON_STATUSES = ['awaiting_input', 'stale', 'terminated'] as const

const EXPECTED_HRC_RUNTIME_ROW_STATUSES = [
  ...EXPECTED_HRC_RUNTIME_STATE_JSON_STATUSES,
  'dead',
  'adopted',
] as const

function collectSourceFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const rel = relative(HRC_REPO_ROOT, path)
    if (
      rel.includes('/__tests__/') ||
      rel.includes('/validation/') ||
      rel.includes('/docs/') ||
      rel.includes('/node_modules/')
    ) {
      continue
    }
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path))
    } else if (path.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}

function readHrcSource(): string {
  const sourceRoots = [
    join(HRC_REPO_ROOT, 'packages/hrc-server/src'),
    join(HRC_REPO_ROOT, 'packages/hrc-core/src'),
    join(HRC_REPO_ROOT, 'packages/hrc-store-sqlite/src'),
  ]
  return sourceRoots
    .flatMap(collectSourceFiles)
    .map((path) => `\n// ${relative(HRC_REPO_ROOT, path)}\n${readFileSync(path, 'utf8')}`)
    .join('\n')
}

describe('T-05007 runtime status vocabulary contract', () => {
  test('exports closed const-array vocabularies and guards with the split runtime-state vs row semantics', () => {
    expect(RUNTIME_STATE_STATUS_VALUES).toEqual([
      'allocating',
      'compiling',
      'admitted',
      'starting',
      'ready',
      'busy',
      'stopping',
      'stopped',
      'failed',
      'unknown_after_restart',
      'disposed',
      'awaiting_input',
      'stale',
      'terminated',
    ])

    expect(RUNTIME_STATUS_VALUES).toEqual([...RUNTIME_STATE_STATUS_VALUES, 'dead', 'adopted'])

    for (const value of RUNTIME_STATE_STATUS_VALUES) {
      expect(isRuntimeStateStatus(value)).toBe(true)
      expect(isRuntimeStatus(value)).toBe(true)
    }

    expect(isRuntimeStateStatus('adopted')).toBe(false)
    expect(isRuntimeStatus('adopted')).toBe(true)
    expect(isRuntimeStateStatus('dead')).toBe(false)
    expect(isRuntimeStatus('dead')).toBe(true)
    expect(isRuntimeStateStatus('zombied')).toBe(false)
    expect(isRuntimeStatus('zombied')).toBe(false)
    expect(isRuntimeStateStatus('custom-plugin-status')).toBe(false)
    expect(isRuntimeStatus('custom-plugin-status')).toBe(false)
  })

  test('covers the real HRC producer vocabulary without admitting adjacent result statuses', () => {
    expect(existsSync(HRC_REPO_ROOT)).toBe(true)
    const hrcSource = readHrcSource()

    for (const status of EXPECTED_HRC_RUNTIME_STATE_JSON_STATUSES) {
      expect(hrcSource).toContain(`status: '${status}'`)
      expect(RUNTIME_STATE_STATUS_VALUES).toContain(status)
      expect(RUNTIME_STATUS_VALUES).toContain(status)
    }

    for (const status of EXPECTED_HRC_RUNTIME_ROW_STATUSES) {
      expect(hrcSource).toContain(`status: '${status}'`)
      expect(RUNTIME_STATUS_VALUES).toContain(status)
    }

    expect(RUNTIME_STATE_STATUS_VALUES).not.toContain('adopted')
    expect(RUNTIME_STATE_STATUS_VALUES).not.toContain('dead')
    expect(RUNTIME_STATE_STATUS_VALUES).not.toContain('zombied')
    expect(RUNTIME_STATUS_VALUES).not.toContain('zombied')
    expect(hrcSource).toContain("status: 'zombied'")
  })
})
