/** Validate every direct-child agent profile through the production v4 parser. */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateAgentRoot } from 'spaces-config'

export interface AgentProfileValidationSummary {
  root: string
  discovered: number
  passed: number
  failed: number
}

function profileAgentRoots(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(root, entry.name))
    .filter((agentRoot) => {
      try {
        return statSync(join(agentRoot, 'agent-profile.toml')).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

export function validateAgentProfiles(
  root: string,
  output: Pick<Console, 'log' | 'error'> = console
): AgentProfileValidationSummary {
  const resolvedRoot = resolve(root)
  let agentRoots: string[]
  try {
    agentRoots = profileAgentRoots(resolvedRoot)
  } catch (error) {
    output.error(`FAIL ${resolvedRoot}: ${error instanceof Error ? error.message : String(error)}`)
    return { root: resolvedRoot, discovered: 0, passed: 0, failed: 1 }
  }

  if (agentRoots.length === 0) {
    output.error(`FAIL ${resolvedRoot}: no direct-child agent-profile.toml files found`)
    return { root: resolvedRoot, discovered: 0, passed: 0, failed: 1 }
  }

  let passed = 0
  let failed = 0
  for (const agentRoot of agentRoots) {
    try {
      validateAgentRoot(agentRoot)
      passed += 1
      output.log(`ok ${agentRoot}`)
    } catch (error) {
      failed += 1
      output.error(`FAIL ${agentRoot}`)
      output.error(error instanceof Error ? error.message : String(error))
    }
  }

  output.log(`validated ${passed}/${agentRoots.length} agent profiles (${failed} failed)`)
  return { root: resolvedRoot, discovered: agentRoots.length, passed, failed }
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.length > 1) {
    console.error('usage: bun scripts/validate-agent-profiles.ts [agents-root]')
    process.exit(2)
  }
  const summary = validateAgentProfiles(args[0] ?? join(homedir(), 'agents'))
  if (summary.discovered === 0 || summary.failed > 0) process.exit(1)
}

if (import.meta.main) main()
