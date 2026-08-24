import { readFileSync } from 'node:fs'

import {
  type AgentCatalogResult,
  type AgentInspectionOperationOutcome,
  catalogAgentsForContext,
  inspectAgentForContext,
} from 'agent-spaces'
import type { Command } from 'commander'

type OutputOptions = { json?: boolean | undefined }

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function printCatalog(catalog: AgentCatalogResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(catalog, null, 2))
    return
  }
  for (const agent of catalog.agents) {
    const counts = `${agent.errorCount} error(s), ${agent.warningCount} warning(s)`
    console.log(`${agent.agentId} — ${agent.displayName} (${counts})`)
    if (agent.role !== null) console.log(`  role: ${agent.role}`)
    console.log(
      `  sources: profile=${agent.sourceAvailability.profile} soul=${agent.sourceAvailability.soul} context=${agent.sourceAvailability.contextTemplate}`
    )
    for (const diagnostic of agent.diagnostics) {
      console.log(`  ${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`)
    }
  }
}

function printInspection(outcome: AgentInspectionOperationOutcome, json: boolean): void {
  if (json || !outcome.ok) {
    console.log(JSON.stringify(outcome, null, 2))
    return
  }
  const { inspection } = outcome
  console.log(`${inspection.identity.agentId} — ${inspection.completeness.kind}`)
  console.log(`freshness: ${inspection.freshness.kind}`)
  for (const part of inspection.parts) {
    console.log(`${part.partId} [${part.kind}] ${part.disposition.kind}`)
  }
  for (const diagnostic of inspection.diagnostics) {
    console.log(`${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`)
  }
}

/** Register read-only catalog and contextual inspection commands. */
export function registerAgentInspectionCommands(program: Command): void {
  const agents = program.command('agents').description('Read-only agent catalog and inspection')

  agents
    .command('catalog')
    .description('Catalog agents using an explicit inspection evaluation context')
    .requiredOption('--context <file>', 'agent-inspection-evaluation-context/v1 JSON file')
    .option('--json', 'Output JSON')
    .action(async (options: OutputOptions & { context: string }) => {
      const catalog = await catalogAgentsForContext({
        evaluationContext: readJson(options.context),
      })
      printCatalog(catalog, options.json === true)
    })

  agents
    .command('inspect')
    .description('Inspect one agent using explicit request and evaluation-context files')
    .requiredOption('--request <file>', 'agent-inspection-request/v1 JSON file')
    .requiredOption('--context <file>', 'agent-inspection-evaluation-context/v1 JSON file')
    .option('--json', 'Output JSON')
    .action(async (options: OutputOptions & { request: string; context: string }) => {
      const outcome = await inspectAgentForContext({
        request: readJson(options.request),
        evaluationContext: readJson(options.context),
      })
      printInspection(outcome, options.json === true)
      if (!outcome.ok) process.exitCode = 1
    })
}
