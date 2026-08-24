import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
} from 'spaces-execution'

import { type InventoryExclusion, inventoryAgents } from './inventory.js'
import { observeCompiler } from './observe-compiler.js'
import { observeSdk } from './observe-sdk.js'
import { verifyParityRows } from './verify.js'

const compilerRuntime = {
  getHarnessAdapter: (harnessId: Parameters<typeof harnessRegistry.getOrThrow>[0]) =>
    harnessRegistry.getOrThrow(harnessId),
  detectAgentLocalComponents,
  planPlacementRuntime,
  prepareCodexRuntimeHome,
  prepareAgentToolRuntime,
}

async function fingerprintPath(root: string): Promise<string> {
  const hash = createHash('sha256')
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory()) {
    hash.update(`f:${root}\0`)
    hash.update(await readFile(root))
    return hash.digest('hex')
  }
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const child = join(path, name.name)
      const rel = relative(root, child)
      const stat = await lstat(child)
      if (stat.isSymbolicLink()) {
        hash.update(`l:${rel}\0${await readlink(child)}`)
      } else if (stat.isDirectory()) {
        hash.update(`d:${rel}\0`)
        await visit(child)
      } else {
        hash.update(`f:${rel}\0`)
        hash.update(await readFile(child))
      }
    }
  }
  await visit(root)
  return hash.digest('hex')
}

export async function runLiveTaskParity(input: {
  agentsRoot: string
  projectRoot: string
  exclusions: InventoryExclusion[]
  agentIds?: readonly string[]
}): Promise<{ valid: number; excluded: number; rows: number }> {
  const inventory = await inventoryAgents({
    agentsRoot: input.agentsRoot,
    exclusions: input.exclusions,
  })
  const candidates =
    input.agentIds === undefined
      ? inventory.valid
      : inventory.valid.filter((candidate) => input.agentIds?.includes(candidate.agentId))
  if (candidates.length === 0) throw new Error('No valid parity agents selected')
  const before = new Map(
    await Promise.all(
      candidates.map(
        async ({ agentId, agentRoot }) => [agentId, await fingerprintPath(agentRoot)] as const
      )
    )
  )
  // These are the shared registry inputs reached via agentRootSearchPath by
  // both entrypoints. Snapshot them separately from mutable agent homes.
  const registryInputs = [
    join(inventory.agentsRoot, 'asp-lock.json'),
    join(inventory.agentsRoot, 'spaces'),
  ]
  const registryBefore = new Map(
    await Promise.all(
      registryInputs.map(async (path) => [path, await fingerprintPath(path)] as const)
    )
  )
  const rows = []
  for (const { agentId, agentRoot } of candidates) {
    const compilerHome = await mkdtemp(join(tmpdir(), `agent-parity-compiler-${agentId}-`))
    const sdkHome = await mkdtemp(join(tmpdir(), `agent-parity-sdk-${agentId}-`))
    const scopeRef = `agent:${agentId}:project:agent-spaces:task:T-PARITY`
    const resolverContext = {
      agentRoot,
      agentsRoot: inventory.agentsRoot,
      agentRootSearchPath: [agentRoot, inventory.agentsRoot],
      projectRoot: input.projectRoot,
      projectId: 'agent-spaces',
      agentId,
      agentName: agentId,
      taskId: 'T-PARITY',
      lane: 'main',
      runMode: 'task' as const,
      now: new Date('2026-08-24T00:00:00.000Z'),
      env: {},
      cwd: input.projectRoot,
      predicateCwd: input.projectRoot,
      predicateEnv: {},
      execCwd: input.projectRoot,
      execEnv: {},
    }
    const placement = {
      agentRoot,
      projectRoot: input.projectRoot,
      cwd: input.projectRoot,
      runMode: 'task' as const,
      bundle: {
        kind: 'agent-project' as const,
        agentName: agentId,
        projectRoot: input.projectRoot,
      },
      correlation: { sessionRef: { scopeRef, laneRef: 'main' } },
    }
    try {
      const compiler = await observeCompiler({
        agentId,
        mode: 'task',
        aspHome: compilerHome,
        runtime: compilerRuntime,
        request: {
          placement,
          aspHome: compilerHome,
          provider: 'openai',
          frontend: 'codex-cli',
          interactionMode: 'headless',
          model: 'gpt-5.6-sol',
          resolverContext,
        },
      })
      const sdk = await observeSdk({
        agentId,
        mode: 'task',
        options: {
          agentId,
          projectId: 'agent-spaces',
          agentRoot,
          projectRoot: input.projectRoot,
          cwd: input.projectRoot,
          aspHome: sdkHome,
          runMode: 'task',
          scopeRef,
          laneRef: 'main',
          // Resources are invariant to the agent's deployment model. Use the
          // same supported harness model as the compiler observation so every
          // valid profile can participate in one deterministic fleet run.
          provider: 'openai',
          model: 'gpt-5.6-sol',
          resolverContext,
        },
      })
      rows.push({ compiler, sdk })
    } finally {
      await Promise.all([
        rm(compilerHome, { recursive: true, force: true }),
        rm(sdkHome, { recursive: true, force: true }),
      ])
    }
  }
  verifyParityRows(rows)
  for (const { agentId, agentRoot } of candidates) {
    if (before.get(agentId) !== (await fingerprintPath(agentRoot)))
      throw new Error(`Agent input changed during parity run: ${agentId}`)
  }
  for (const path of registryInputs) {
    if (registryBefore.get(path) !== (await fingerprintPath(path)))
      throw new Error(`Registry input changed during parity run: ${path}`)
  }
  return { valid: inventory.valid.length, excluded: inventory.excluded.length, rows: rows.length }
}
