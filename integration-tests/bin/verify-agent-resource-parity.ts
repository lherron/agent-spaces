#!/usr/bin/env bun
import { resolve } from 'node:path'

import { readInventoryExclusions } from '../lib/agent-resource-parity/inventory.js'
import { parityModes, runLiveTaskParity } from '../lib/agent-resource-parity/live-task.js'

const args = process.argv.slice(2)
const requestedMode = args[args.indexOf('--mode') + 1] ?? 'all'
const modes =
  requestedMode === 'all'
    ? parityModes
    : parityModes.includes(requestedMode as never)
      ? [requestedMode as (typeof parityModes)[number]]
      : undefined
if (modes === undefined) throw new Error(`Unsupported parity mode: ${requestedMode}`)
const agentsRoot = resolve(process.env['ASP_AGENTS_ROOT'] ?? '/Users/lherron/praesidium/var/agents')
const agentIds = args.filter((_value, index) => args[index - 1] === '--agent')
const exclusions = await readInventoryExclusions(
  new URL('../fixtures/agent-resource-parity/exclusions.json', import.meta.url).pathname
)
const results = []
for (const mode of modes) {
  results.push(
    await runLiveTaskParity({
      agentsRoot,
      projectRoot: process.cwd(),
      exclusions,
      modes: [mode],
      ...(agentIds.length > 0 ? { agentIds } : {}),
    })
  )
}
const [result] = results
if (result === undefined) throw new Error('No parity modes selected')
console.log(
  `agent resource parity: PASS\nvalid agents: ${result.valid}\nexcluded candidates: ${result.excluded}\nmodes: ${modes.join(', ')}\nrows compared: ${results.reduce((total, row) => total + row.rows, 0)}`
)
