#!/usr/bin/env bun
import { resolve } from 'node:path'

import { readInventoryExclusions } from '../lib/agent-resource-parity/inventory.js'
import { runLiveTaskParity } from '../lib/agent-resource-parity/live-task.js'

const args = process.argv.slice(2)
const mode = args[args.indexOf('--mode') + 1] ?? 'task'
if (mode !== 'task') throw new Error(`Only --mode task is available in this gate; received ${mode}`)
const agentsRoot = resolve(process.env['ASP_AGENTS_ROOT'] ?? '/Users/lherron/praesidium/var/agents')
const agentIds = args.filter((_value, index) => args[index - 1] === '--agent')
const exclusions = await readInventoryExclusions(
  new URL('../fixtures/agent-resource-parity/exclusions.json', import.meta.url).pathname
)
const result = await runLiveTaskParity({
  agentsRoot,
  projectRoot: process.cwd(),
  exclusions,
  ...(agentIds.length > 0 ? { agentIds } : {}),
})
console.log(
  `agent resource parity: mode=task valid=${result.valid} excluded=${result.excluded} rows=${result.rows}`
)
