#!/usr/bin/env bun

/**
 * Run the live Codex presentation smoke through the public v2 matrix contract.
 * The catalog owns the `codex` + `presentation: true` execution choice; this
 * script deliberately has no driver or frontend selector of its own.
 */
import { runPreHrcBrokerMatrixE2e } from './pre-hrc-broker-matrix-e2e.ts'

try {
  const report = await runPreHrcBrokerMatrixE2e([...process.argv.slice(2), '--config', 'codex-tui'])
  if (!report.ok) process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 2
}
