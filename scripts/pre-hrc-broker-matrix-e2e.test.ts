import { describe, expect, test } from 'bun:test'

import {
  BROKER_MANAGED_MATRIX_ROWS,
  MATRIX_ROW_NAMES,
  SPARKY_CODEX_MATRIX_ROWS,
} from './pre-hrc-broker-matrix-e2e.ts'

describe('pre-HRC broker matrix v2 catalog', () => {
  test('keeps only broker-managed catalog routes', () => {
    expect(BROKER_MANAGED_MATRIX_ROWS).toEqual(MATRIX_ROW_NAMES)
    expect(MATRIX_ROW_NAMES).toEqual([
      'fake-codex',
      'unix-jsonrpc-ndjson',
      'real-codex',
      'codex-tui',
      'real-claude-tmux',
      'real-muse-serve',
      'muse-tmux',
    ])
  })

  test('covers headless and presentation Codex through one closed harness id', () => {
    expect(SPARKY_CODEX_MATRIX_ROWS).toContain('fake-codex')
    expect(SPARKY_CODEX_MATRIX_ROWS).toContain('codex-tui')
  })
})
