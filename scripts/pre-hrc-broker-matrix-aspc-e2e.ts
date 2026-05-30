#!/usr/bin/env bun
import { runPreHrcBrokerMatrixE2e } from './pre-hrc-broker-matrix-e2e.ts'

try {
  await runPreHrcBrokerMatrixE2e(process.argv.slice(2), { compileTransport: 'aspc-rpc' })
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exit(2)
}
