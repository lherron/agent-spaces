import type { Command } from 'commander'
import {
  compileResourcesPlan,
  inferProjectIdFromCwd,
  resolveAgentPlacementPaths,
} from 'spaces-config'

interface ResourcesPlanOptions {
  project?: string | undefined
  agentRoot?: string | undefined
  aspHome?: string | undefined
}

export function registerResourcesCommands(program: Command): void {
  const resources = program.command('resources').description('Agent-authored runtime resources')

  resources
    .command('plan')
    .description('Compile an agent-authored runtime resources plan')
    .argument('<agent>', 'Agent id')
    .requiredOption('--project <project>', 'Project id')
    .option('--agent-root <path>', 'Absolute path to agent root')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (agent: string, options: ResourcesPlanOptions) => {
      const projectId = options.project ?? inferProjectIdFromCwd({ aspHome: options.aspHome })
      if (!projectId) {
        throw new Error('resources plan requires --project <project>')
      }

      const paths = resolveAgentPlacementPaths({
        agentId: agent,
        projectId,
        ...(options.agentRoot ? { agentRoot: options.agentRoot } : {}),
        ...(options.aspHome ? { aspHome: options.aspHome } : {}),
      })
      const agentRoot = paths.agentRoot
      if (!agentRoot) {
        const searched = paths.searchedAgentRoots?.length
          ? ` Searched: ${paths.searchedAgentRoots.join(', ')}`
          : ''
        throw new Error(`Agent root not found for ${agent}.${searched}`)
      }

      const plan = await compileResourcesPlan({
        agentRoot,
        owner: {
          projectId,
          agentId: agent,
          scopeRef: `agent:${agent}:project:${projectId}`,
        },
      })

      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      process.stderr.write(formatResourcesSummary(agent, projectId, agentRoot, plan.resources))
    })
}

function formatResourcesSummary(
  agent: string,
  projectId: string,
  agentRoot: string,
  resources: unknown[]
): string {
  const counts = new Map<string, number>()
  for (const resource of resources) {
    const kind =
      isRecord(resource) && typeof resource['resourceKind'] === 'string'
        ? resource['resourceKind']
        : 'unknown'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }

  const ordered = ['scheduled-job', 'interface-binding', 'event-hook']
    .filter((kind) => counts.has(kind))
    .map((kind) => `${kind}=${counts.get(kind)}`)
    .join(' ')
  return `Compiled resources plan for ${agent}@${projectId}: ${resources.length} resources${
    ordered ? ` (${ordered})` : ''
  }\nAgent root: ${agentRoot}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
