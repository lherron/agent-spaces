#!/usr/bin/env bun
/**
 * Real-Codex E2E Smoke Harness
 *
 * Drives the COMPLETE broker flow against a real installed Codex app-server:
 *   ScopeRef -> RuntimePlacement -> buildHarnessBrokerInvocation -> BrokerClient -> turn lifecycle
 *
 * Default prompt exercises both real shell execution and priming introspection:
 * it asks Codex to run `pwd`, then reply with a marker and the runtime scope
 * handle from its priming context.
 *
 * Usage:
 *   bun scripts/smoke-asp-broker-real-codex.ts \
 *     --scope-ref cody@agent-spaces \
 *     --asp-home /tmp/asp-broker-smoke \
 *     --timeout 120
 *
 * Exit codes:
 *   0  Success — all required events observed, turn completed successfully
 *   1  Assertion failure — required event missing or turn failed/interrupted
 *   2  Broker/Codex startup failure
 */
import { mkdirSync } from 'node:fs'

import { BrokerClient } from '../packages/harness-broker-client/src/index.ts'

import {
  parseArgs,
  printUsage,
  selectedScenarios,
  scenarioArgs,
} from './lib/broker-smoke/args.ts'
import { runHappyScenario } from './lib/broker-smoke/scenarios/happy.ts'
import { runQueuePolicyScenario } from './lib/broker-smoke/scenarios/queue-policy.ts'

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  mkdirSync(args.aspHome, { recursive: true })
  const scenarios = selectedScenarios(args.scenario)
  const multiScenario = scenarios.length > 1

  console.log(`[smoke] selected scenario(s): ${scenarios.join(', ')}`)
  console.log()

  console.log('[smoke] Starting broker process...')
  const repoRoot = new URL('..', import.meta.url).pathname
  let brokerClient: BrokerClient
  try {
    brokerClient = await BrokerClient.start({
      command: 'bun',
      args: ['packages/harness-broker/bin/harness-broker.js', 'run', '--transport', 'stdio'],
      cwd: repoRoot,
    })
  } catch (err) {
    console.error('[smoke] Failed to start broker:', err)
    process.exit(2)
  }
  console.log('[smoke]   Broker process started.')
  console.log()

  try {
    console.log('[smoke] Sending broker.hello...')
    const helloResp = await brokerClient.hello({
      clientInfo: { name: 'smoke-asp-broker-real-codex', version: '0.1.0' },
      protocolVersions: ['harness-broker/0.1'],
      capabilities: { permissionRequests: true },
    })
    console.log(`[smoke]   Broker: ${helloResp.brokerInfo.name} v${helloResp.brokerInfo.version}`)
    console.log(`[smoke]   Protocol: ${helloResp.protocolVersion}`)
    console.log(`[smoke]   Drivers: ${helloResp.drivers.map((d) => d.kind).join(', ')}`)
    console.log()

    brokerClient.onPermissionRequest(async (req) => {
      console.log(`[smoke]   Permission request: ${req.kind} -> deny`)
      return { decision: 'deny' as const }
    })

    let failures = 0
    for (const scenario of scenarios) {
      const run = { name: scenario, args: scenarioArgs(args, scenario, multiScenario) }
      failures +=
        scenario === 'happy'
          ? await runHappyScenario(brokerClient, run)
          : await runQueuePolicyScenario(brokerClient, run)
    }

    if (failures > 0) {
      console.error(`[smoke] FAILED: ${failures} assertion(s) failed`)
      process.exitCode = 1
      return
    }

    console.log('[smoke] SUCCESS: All selected scenario assertions passed')
  } finally {
    try {
      await brokerClient.close()
      console.log('[smoke] Broker client closed.')
    } catch {
      // Best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

try {
  await main()
} catch (err) {
  console.error('[smoke] Fatal error:', err)
  process.exit(2)
}
